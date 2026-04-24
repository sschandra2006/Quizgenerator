/* QuizAI v5 — Per-question countdown timer + backend generation + MongoDB history */

const state = {
  mode: 'text',
  difficulty: 'medium',
  questionCount: 5,
  timeLimit: 30,
  selectedFile: null,
  questions: [],
  currentIndex: 0,
  userAnswers: {},
  score: 0,
  timerSeconds: 0,
  timerInterval: null,
  countdownSeconds: 0,
  countdownInterval: null,
  quizTopic: '',
  sessionId: null,   // last saved MongoDB session ID
  metadata: null,    // AI roasts, personality ranks, etc.
  personality: 'standard',
};

const screens = {
  input: document.getElementById('inputScreen'),
  loading: document.getElementById('loadingScreen'),
  quiz: document.getElementById('quizScreen'),
  results: document.getElementById('resultsScreen'),
};

// ══ Auth & API ══════════════════════════════════════════════
let _token = localStorage.getItem('quizai_token');
let _user  = JSON.parse(localStorage.getItem('quizai_user') || 'null');

// ══ Audio System ════════════════════════════════════════════
let _audioMode = false;

function toggleAudioMode() {
  _audioMode = !_audioMode;
  const btn = document.getElementById('audioToggleBtn');
  if (_audioMode) {
    if(btn) { btn.innerHTML = '🔊 Sound: ON'; btn.style.color = 'var(--success)'; }
  } else {
    if(btn) { btn.innerHTML = '🔇 Sound: OFF'; btn.style.color = ''; }
    window.speechSynthesis.cancel();
  }
}

function speakQuestion(text) {
  if (!_audioMode) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  utter.voice = voices.find(v => v.name.includes('Google') || v.name.includes('Samantha') || v.name.includes('Microsoft')) || voices[0];
  utter.pitch = 1.1;
  utter.rate = 1.05;
  window.speechSynthesis.speak(utter);
}

function playSound(type) {
  if (!_audioMode) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  
  if (type === 'correct') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, ctx.currentTime);
    osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } else if (type === 'incorrect') {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  }
}

// ── Voice Interaction ───────────────────────────────────────
let _recognition = null;
let _voiceActive = false;

function toggleVoiceInput() {
  const btn = document.getElementById('voiceBtn');
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    showToast('Voice Recognition not supported in this browser.', 'error');
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  
  if (!_voiceActive) {
    if (!_recognition) {
      _recognition = new SpeechRecognition();
      _recognition.continuous = true;
      _recognition.interimResults = false;
      _recognition.lang = 'en-US';

      _recognition.onresult = (event) => {
        const last = event.results.length - 1;
        const transcript = event.results[last][0].transcript.toLowerCase().trim();
        console.log('🎤 Voice captured:', transcript);

        if (transcript.includes('option a') || transcript.match(/\ba\b/)) selectAnswer('A');
        else if (transcript.includes('option b') || transcript.match(/\bb\b/)) selectAnswer('B');
        else if (transcript.includes('option c') || transcript.match(/\bc\b/)) selectAnswer('C');
        else if (transcript.includes('option d') || transcript.match(/\bd\b/)) selectAnswer('D');
      };

      _recognition.onstart = () => {
        _voiceActive = true;
        if(btn) { btn.innerHTML = '🎤 Listening...'; btn.style.color = 'var(--success)'; btn.style.borderColor = 'var(--success)'; }
        showToast('Hands-free mode active! Say A, B, C, or D.', 'success');
      };

      _recognition.onend = () => {
        if (_voiceActive) _recognition.start(); // Keep listening during quiz
      };

      _recognition.onerror = (err) => {
        console.warn('Speech error:', err.error);
        if (err.error === 'not-allowed') {
          _voiceActive = false;
          showToast('Mic permission denied.', 'error');
        }
      };
    }
    _recognition.start();
  } else {
    _voiceActive = false;
    if (_recognition) _recognition.stop();
    if(btn) { btn.innerHTML = '🎤 Mic Off'; btn.style.color = '#ef4444'; btn.style.borderColor = '#ef4444'; }
    showToast('Voice input disabled.', 'warning');
  }
}

async function apiFetch(endpoint, options = {}) {
  if (!options.headers) options.headers = {};
  if (_token) options.headers['Authorization'] = `Bearer ${_token}`;
  const res = await fetch(endpoint, options);
  if (res.status === 401) {
    localStorage.removeItem('quizai_token');
    localStorage.removeItem('quizai_user');
    window.location.href = '/login.html';
  }
  return res;
}

function checkAuth() {
  if (!_token) {
    window.location.href = '/login.html';
    return;
  }
  if (_user) {
    document.getElementById('userProfile').classList.remove('hidden');
    document.getElementById('navUserAvatar').textContent = _user.username.charAt(0).toUpperCase();
    document.getElementById('navUserName').textContent = _user.username;
    document.getElementById('navUserLevel').textContent = `Lvl ${_user.level} ${_user.levelTitle}`;
    if(document.getElementById('menuXp')) document.getElementById('menuXp').textContent = _user.xp;
  }
  apiFetch('/api/auth/me').then(r => r.json()).then(data => {
    if(data.success) {
      _user = data.user;
      localStorage.setItem('quizai_user', JSON.stringify(_user));
      document.getElementById('navUserLevel').textContent = `Lvl ${_user.level} ${_user.levelTitle}`;
      if(document.getElementById('menuXp')) document.getElementById('menuXp').textContent = _user.xp || 0;
      if(document.getElementById('menuRank')) document.getElementById('menuRank').textContent = data.user.rank ? `#${data.user.rank}` : '-';
      renderQuests();
    }
  }).catch(e => console.warn(e));
}

function toggleQuests() {
  const menu = document.getElementById('questsMenu');
  if (menu) menu.classList.toggle('hidden');
}

function renderQuests() {
  const list = document.getElementById('questsList');
  if (!list || !_user || !_user.dailyQuests || !_user.dailyQuests.length) {
    if(list) list.innerHTML = '<div class="u-drop-item" style="color:var(--text-muted);font-size:0.8rem;text-align:center;padding:20px;">No quests active right now.</div>';
    return;
  }
  
  let html = '';
  _user.dailyQuests.forEach(q => {
    const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
    html += `
      <div class="quest-item ${q.completed ? 'completed' : ''}">
        <div style="display:flex; justify-content:space-between; margin-bottom: 6px;">
          <span style="color:var(--text-primary); font-weight:600;">${q.title}</span>
          <span class="quest-prog">${q.progress}/${q.target}</span>
        </div>
        <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow:hidden; margin-bottom: 6px;">
          <div style="height: 100%; width: ${pct}%; background: var(--accent-primary); transition: width 0.3s; box-shadow: 0 0 10px var(--accent-primary);"></div>
        </div>
        <span style="color:var(--accent-secondary); font-size: 0.75rem; font-weight:700;">+${q.xpReward} XP</span>
      </div>
    `;
  });
  list.innerHTML = html;
}

function toggleUserMenu() {
  const menu = document.getElementById('userMenu');
  if (menu) menu.classList.toggle('hidden');
}

function logout() {
  localStorage.removeItem('quizai_token');
  localStorage.removeItem('quizai_user');
  window.location.href = '/login.html';
}

document.addEventListener('DOMContentLoaded', () => { 
  checkAuth();
  showScreen('input'); 
});

// ══ Screen ═════════════════════════════════════════════════
function showScreen(name) {
  Object.values(screens).forEach(s => s && s.classList.remove('active'));
  if (screens[name]) { screens[name].classList.add('active'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}

// ══ Mode / Difficulty / Count / TimeLimit ═════════════════
function switchMode(mode) {
  state.mode = mode;
  document.getElementById('btnTextMode').classList.toggle('active', mode === 'text');
  document.getElementById('btnPdfMode').classList.toggle('active', mode === 'pdf');
  document.getElementById('btnUrlMode').classList.toggle('active', mode === 'url');
  document.getElementById('textInputSection').classList.toggle('hidden', mode !== 'text');
  document.getElementById('pdfInputSection').classList.toggle('hidden', mode !== 'pdf');
  document.getElementById('urlInputSection').classList.toggle('hidden', mode !== 'url');
}

function selectDifficulty(level) {
  state.difficulty = level;
  ['easy', 'medium', 'hard'].forEach(d => {
    const el = document.getElementById('diff' + d.charAt(0).toUpperCase() + d.slice(1));
    if (el) el.classList.toggle('active', d === level);
  });
}

function adjustCount(delta) {
  state.questionCount = Math.min(Math.max(state.questionCount + delta, 1), 20);
  document.getElementById('questionCountDisplay').textContent = state.questionCount;
}

function selectTimeLimit(seconds) {
  state.timeLimit = seconds;
  document.querySelectorAll('.timelimit-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.value) === seconds);
  });
}

// ══ File handling ═══════════════════════════════════════════
function handleFileSelect(e) { const f = e.target.files[0]; if (f) setFile(f); }
function setFile(file) {
  if (file.type !== 'application/pdf') { showToast('Only PDF files are supported.', 'error'); return; }
  if (file.size > 50 * 1024 * 1024) { showToast('Max 50MB.', 'error'); return; }
  state.selectedFile = file;
  document.getElementById('dropZone').classList.add('hidden');
  document.getElementById('fileInfo').classList.remove('hidden');
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = formatFileSize(file.size);
}
function removeFile() {
  state.selectedFile = null;
  document.getElementById('pdfInput').value = '';
  document.getElementById('dropZone').classList.remove('hidden');
  document.getElementById('fileInfo').classList.add('hidden');
}
function handleDragOver(e) { e.preventDefault(); document.getElementById('dropZone').classList.add('dragover'); }
function handleDragLeave() { document.getElementById('dropZone').classList.remove('dragover'); }
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('dropZone').classList.remove('dragover');
  const f = e.dataTransfer.files[0]; if (f) setFile(f);
}
function formatFileSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

// ══ GENERATION ════════════════════════════════════════════
async function generateQuiz() {
  const btn = document.getElementById('generateBtn');

  if (state.mode === 'text') {
    const topic = document.getElementById('topicInput').value.trim();
    if (!topic) { showToast('Please enter a topic.', 'warning'); return; }
    state.quizTopic = topic;
  } else if (state.mode === 'url') {
    const url = document.getElementById('urlInput').value.trim();
    if (!url) { showToast('Please enter a URL.', 'warning'); return; }
    state.quizTopic = url;
  } else {
    if (!state.selectedFile) { showToast('Please upload a PDF file.', 'warning'); return; }
    state.quizTopic = state.selectedFile.name;
  }

  btn.disabled = true;
  btn.classList.add('generating');
  showScreen('loading');
  startLoadingAnimation();

  try {
    let extractedText = '';
    let topicText = '';

    if (state.mode === 'pdf') {
      updateLoadingStatus('Extracting PDF text...');
      updateLoadingStep(1, 'Extracting text from PDF...');
      const formData = new FormData();
      formData.append('pdf', state.selectedFile);
      const extractRes = await apiFetch('/api/extract', { method: 'POST', body: formData });
      const extractData = await extractRes.json();
      if (!extractRes.ok || !extractData.success) throw new Error(extractData.error || 'Failed to extract PDF.');
      extractedText = extractData.text;
      updateLoadingStep(1, `✓ Extracted ${extractedText.length.toLocaleString()} characters`);
    } else if (state.mode === 'url') {
      const url = document.getElementById('urlInput').value.trim();
      updateLoadingStatus('Fetching URL content...');
      updateLoadingStep(1, 'Fetching webpage...');
      setUrlStatus('⏳ Fetching ' + url + '...', 'loading');
      const urlRes = await apiFetch('/api/extract-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const urlData = await urlRes.json();
      if (!urlRes.ok || !urlData.success) throw new Error(urlData.error || 'Failed to fetch URL.');
      extractedText = urlData.text;
      setUrlStatus('✓ Fetched ' + extractedText.length.toLocaleString() + ' characters', 'success');
      updateLoadingStep(1, `✓ Fetched ${extractedText.length.toLocaleString()} characters from URL`);
    } else {
      topicText = document.getElementById('topicInput').value.trim();
      updateLoadingStep(1, '✓ Topic ready');
    }

    updateLoadingStep(2, 'Calling AI (OpenAI)...');
    updateLoadingStatus('Generating questions...');

    state.personality = document.getElementById('personalityTone')?.value || 'standard';

    const resp = await apiFetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        topic: topicText, 
        extractedText, 
        difficulty: state.difficulty, 
        count: state.questionCount,
        personality: state.personality
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.error || 'Generation failed — please retry.');

    const questions = data.quiz;
    if (!questions || questions.length === 0) throw new Error('No questions returned. Please try again.');

    state.metadata = data.metadata;

    updateLoadingStep(3, `✓ ${questions.length} questions created`);
    updateLoadingStep(4, '✓ Quiz ready!');

    state.questions = questions;
    state.currentIndex = 0;
    state.userAnswers = {};
    state.score = 0;

    const diffBadge = document.getElementById('quizDifficultyBadge');
    if (diffBadge) { diffBadge.textContent = state.difficulty.charAt(0).toUpperCase() + state.difficulty.slice(1); diffBadge.setAttribute('data-diff', state.difficulty); }
    const srcBadge = document.getElementById('quizSourceBadge');
    if (srcBadge) {
      if (state.mode === 'pdf') srcBadge.textContent = '📄 PDF';
      else if (state.mode === 'url') srcBadge.textContent = '🌐 URL';
      else srcBadge.textContent = '✏️ Topic';
    }

    await sleep(300);
    buildQuestionDots();
    showQuestion(0);
    showScreen('quiz');
    startGlobalTimer();

  } catch (err) {
    showScreen('input');
    showToast('❌ ' + err.message, 'error');
    console.error('[generateQuiz] Error:', err);
  } finally {
    btn.disabled = false;
    btn.classList.remove('generating');
    stopLoadingAnimation();
  }
}

// ══ GLOBAL TIMER (total elapsed) ══════════════════════════
function startGlobalTimer() {
  state.timerSeconds = 0;
  clearInterval(state.timerInterval);
  const el = document.getElementById('totalTimerDisplay');
  if (el) state.timerInterval = setInterval(() => {
    state.timerSeconds++;
    el.textContent = '⏱ ' + formatTime(state.timerSeconds);
  }, 1000);
}

function stopGlobalTimer() { clearInterval(state.timerInterval); }
function formatTime(s) { return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }

// ══ PER-QUESTION COUNTDOWN ════════════════════════════════
function startCountdown() {
  clearInterval(state.countdownInterval);
  const el = document.getElementById('countdownDisplay');
  if (!el) return;

  if (state.timeLimit === 0) {
    el.classList.add('hidden');
    return;
  }

  el.classList.remove('hidden', 'warning', 'danger');
  state.countdownSeconds = state.timeLimit;
  _updateCountdownUI();

  state.countdownInterval = setInterval(() => {
    state.countdownSeconds--;
    _updateCountdownUI();
    if (state.countdownSeconds <= 0) {
      clearInterval(state.countdownInterval);
      _onTimeUp();
    }
  }, 1000);
}

function stopCountdown() {
  clearInterval(state.countdownInterval);
  const el = document.getElementById('countdownDisplay');
  if (el) el.classList.add('hidden');
}

function _updateCountdownUI() {
  const el = document.getElementById('countdownDisplay');
  if (!el) return;
  const s = state.countdownSeconds;
  el.textContent = '⏳ ' + s + 's';
  const pct = s / state.timeLimit;
  el.classList.remove('warning', 'danger');
  if (pct <= 0.2) el.classList.add('danger');
  else if (pct <= 0.4) el.classList.add('warning');
}

function _onTimeUp() {
  if (state.userAnswers[state.currentIndex] !== undefined) return;

  // Flash card red
  const card = document.getElementById('questionCard');
  if (card) { card.classList.add('timeup-flash'); setTimeout(() => card.classList.remove('timeup-flash'), 700); }

  // Mark as timed-out, reveal correct answer
  const q = state.questions[state.currentIndex];
  state.userAnswers[state.currentIndex] = null;

  document.querySelectorAll('.option-btn').forEach(btn => {
    btn.disabled = true;
    if (btn.querySelector('.option-label').textContent === q.correctAnswer) btn.classList.add('correct');
  });

  const dot = document.getElementById('dot-' + state.currentIndex);
  if (dot) { dot.classList.remove('active'); dot.classList.add('incorrect'); }

  showExplanation(false, "⏰ Time's up! " + q.explanation);
  showToast("⏰ Time's up! Moving on...", 'warning');

  // Auto-advance after 1.5s
  setTimeout(() => {
    if (state.currentIndex < state.questions.length - 1) showQuestion(state.currentIndex + 1);
    else finishQuiz();
  }, 1500);
}

// ══ LOADING UI ════════════════════════════════════════════
let _loadingTimer = null;
function startLoadingAnimation() {
  ['step1', 'step2', 'step3', 'step4'].forEach(id => { const e = document.getElementById(id); if (e) e.classList.remove('active', 'completed'); });
  const s1 = document.getElementById('step1'); if (s1) s1.classList.add('active');
  const bar = document.getElementById('loadingBar'); if (bar) bar.style.width = '5%';
}
function updateLoadingStep(step, message) {
  const el = document.getElementById('step' + step);
  if (!el) return;
  const span = el.querySelector('span');
  if (span) span.textContent = message;
  if (message.startsWith('✓')) {
    el.classList.remove('active'); el.classList.add('completed');
    const nxt = document.getElementById('step' + (step + 1));
    if (nxt) nxt.classList.add('active');
    const bar = document.getElementById('loadingBar');
    if (bar) bar.style.width = (step * 25) + '%';
  }
}
function updateLoadingStatus(msg) { const el = document.getElementById('loadingStatus'); if (el) el.textContent = msg; }
function stopLoadingAnimation() {
  if (_loadingTimer) { clearInterval(_loadingTimer); _loadingTimer = null; }
  const bar = document.getElementById('loadingBar'); if (bar) bar.style.width = '100%';
}

// ══ QUIZ DISPLAY ══════════════════════════════════════════
function useHint() {
  const q = state.questions[state.currentIndex];
  if (!q) return;
  if (_user && _user.xp < 10) return showToast('Not enough XP! Complete quests to earn more.', 'error');
  
  if (_user) _user.xp -= 10;
  if (document.getElementById('menuXp')) document.getElementById('menuXp').textContent = _user.xp;
  
  const hintTxt = q.hint || 'No hint provided.';
  showToast('💡 Hint: ' + hintTxt, 'success');
  speakQuestion("Hint: " + hintTxt);
}

function buildQuestionDots() {
  const c = document.getElementById('questionDots'); if (!c) return;
  c.innerHTML = '';
  state.questions.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'dot' + (i === 0 ? ' active' : '');
    d.id = 'dot-' + i;
    d.onclick = () => { stopCountdown(); showQuestion(i); };
    c.appendChild(d);
  });
}

function showQuestion(index) {
  const q = state.questions[index]; if (!q) return;
  state.currentIndex = index;
  const total = state.questions.length;

  document.getElementById('progressText').textContent = `Question ${index + 1} of ${total}`;
  document.getElementById('scoreDisplay').textContent = `Score: ${state.score}`;
  document.getElementById('quizProgressBar').style.width = `${((index + 1) / total) * 100}%`;
  document.getElementById('questionNumber').textContent = String(index + 1).padStart(2, '0');
  document.getElementById('questionText').textContent = q.question;

  document.querySelectorAll('.dot').forEach((d, i) => d.classList.toggle('active', i === index));

  const grid = document.getElementById('optionsGrid');
  grid.innerHTML = '';
  const answered = state.userAnswers[index];

  Object.entries(q.options).forEach(([key, value], oi) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.id = 'option-' + key;
    btn.style.animationDelay = `${oi * 80}ms`;
    if (answered !== undefined) {
      if (key === q.correctAnswer) btn.classList.add('correct');
      else if (key === answered) btn.classList.add('incorrect');
      btn.disabled = true;
    }
    btn.onclick = () => selectAnswer(key);
    btn.innerHTML = `<span class="option-label">${key}</span><span class="option-text">${value}</span>`;
    grid.appendChild(btn);
  });

  const panel = document.getElementById('explanationPanel');
  if (answered !== undefined) {
    showExplanation(answered === q.correctAnswer, q.explanation);
    stopCountdown();
  } else {
    panel.className = 'explanation-panel hidden';
    startCountdown();
  }

  document.getElementById('prevBtn').disabled = index === 0;
  const nextBtn = document.getElementById('nextBtn');
  if (index === total - 1) { nextBtn.textContent = 'See Results →'; nextBtn.onclick = () => finishQuiz(); }
  else { nextBtn.textContent = 'Next →'; nextBtn.onclick = () => nextQuestion(); }

  const card = document.getElementById('questionCard');
  card.style.animation = 'none'; card.offsetHeight;
  card.style.animation = 'questionSlideIn 0.4s cubic-bezier(0.16,1,0.3,1) forwards';

  // Speak the question and options
  let speech = q.question + ". ";
  Object.entries(q.options).forEach(([k, v]) => { speech += `Option ${k}: ${v}. `; });
  speakQuestion(speech);
}

function selectAnswer(key) {
  if (state.userAnswers[state.currentIndex] !== undefined) return;
  stopCountdown();
  const q = state.questions[state.currentIndex];
  const ok = key === q.correctAnswer;
  state.userAnswers[state.currentIndex] = key;
  if (ok) state.score++;

  document.querySelectorAll('.option-btn').forEach(btn => {
    btn.disabled = true;
    const k = btn.querySelector('.option-label').textContent;
    if (k === q.correctAnswer) btn.classList.add('correct');
    else if (k === key && !ok) { btn.classList.add('incorrect'); btn.classList.add('shake'); }
  });

  const dot = document.getElementById('dot-' + state.currentIndex);
  if (dot) { dot.classList.remove('active'); dot.classList.add(ok ? 'correct' : 'incorrect'); }

  showExplanation(ok, q.explanation);
  document.getElementById('scoreDisplay').textContent = `Score: ${state.score}`;

  if (state.currentIndex === state.questions.length - 1) {
    const nb = document.getElementById('nextBtn');
    nb.textContent = 'See Results →'; nb.onclick = () => finishQuiz();
  }
  
  playSound(ok ? 'correct' : 'incorrect');
}

function showExplanation(ok, explanation) {
  const panel = document.getElementById('explanationPanel');
  panel.className = `explanation-panel ${ok ? 'correct' : 'incorrect'}`;
  document.getElementById('explanationIcon').innerHTML = ok
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  document.getElementById('explanationTitle').textContent = ok ? '✓ Correct!' : '✗ Incorrect';
  document.getElementById('explanationText').textContent = explanation || '';
}

function nextQuestion() { stopCountdown(); if (state.currentIndex < state.questions.length - 1) showQuestion(state.currentIndex + 1); }
function previousQuestion() { stopCountdown(); if (state.currentIndex > 0) showQuestion(state.currentIndex - 1); }

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (!screens.quiz || !screens.quiz.classList.contains('active')) return;
  const km = { a: 'A', b: 'B', c: 'C', d: 'D', '1': 'A', '2': 'B', '3': 'C', '4': 'D' };
  const ans = km[e.key.toLowerCase()];
  if (ans && state.userAnswers[state.currentIndex] === undefined) { selectAnswer(ans); return; }
  if (e.key === 'ArrowRight' || e.key === 'n') nextQuestion();
  if (e.key === 'ArrowLeft' || e.key === 'p') previousQuestion();
});

// ══ RESULTS ═══════════════════════════════════════════════
function finishQuiz() {
  stopGlobalTimer();
  stopCountdown();
  const total = state.questions.length;
  const correct = state.score;
  const pct = Math.round((correct / total) * 100);

  // ── Auto-save to MongoDB ─────────────────────────────────
  saveQuizSession(pct);

  setTimeout(() => {
    const ring = document.getElementById('scoreRingFill');
    if (ring) {
      const circ = 2 * Math.PI * 85;
      ring.style.strokeDashoffset = circ - (pct / 100) * circ;
      const c = pct >= 80 ? '#34d399' : pct >= 60 ? '#fbbf24' : pct >= 40 ? '#fb923c' : '#f87171';
      ring.setAttribute('stroke', c);
    }
  }, 100);

  document.getElementById('scorePercentage').textContent = pct + '%';
  document.getElementById('correctCount').textContent = correct;
  document.getElementById('incorrectCount').textContent = total - correct;
  document.getElementById('totalCount').textContent = total;
  const te = document.getElementById('timeTaken'); if (te) te.textContent = formatTime(state.timerSeconds);

  let title, subtitle;
  if (pct === 100) { title = '🏆 Perfect!'; subtitle = 'You nailed every question!'; }
  else if (pct >= 80) { title = '🎉 Excellent!'; subtitle = `${correct}/${total} correct. Great work!`; }
  else if (pct >= 60) { title = '👍 Good Job!'; subtitle = `${correct}/${total} correct. Keep it up!`; }
  else if (pct >= 40) { title = '📚 Keep Studying!'; subtitle = `${correct}/${total} correct. Review and retry.`; }
  else { title = "💪 Don't Give Up!"; subtitle = `${correct}/${total} correct. Practice makes perfect!`; }

  document.getElementById('resultsTitle').textContent = title;
  document.getElementById('resultsSubtitle').textContent = subtitle;
  buildReview();
  showScreen('results');
  
  // Show AI Roast
  const roastContainer = document.getElementById('aiRoastContainer');
  const roastText = document.getElementById('aiRoastText');
  if (roastContainer && roastText) {
    const isGood = pct >= 80;
    let roastContent = "";

    if (state.metadata && state.metadata.roast) {
      roastContent = isGood ? state.metadata.roast.high : state.metadata.roast.low;
    } else {
      // Local Fallback Roasts if AI fails
      const fallbacks = {
        standard:    { low: "You have room to grow. Keep practicing!",                                    high: "Excellent work! You've mastered this topic." },
        snarky:      { low: "Is your brain on airplane mode? Try again.",                                high: "Wow, you actually know things. I'm impressed." },
        genz:        { low: "L choice, fr fr. You need to lock in.",                                     high: "Major W. You're literally the main character." },
        pirate:      { low: "Ye be a scallywag! Walk the plank and study more!",                        high: "Ahoy! Ye be the finest captain on the seven seas!" },
        academic:    { low: "Your performance was suboptimal. Further study is required.",               high: "Your intellectual prowess is truly remarkable." },
        shakespeare: { low: "Forsooth, thou hast stumbled most grievously. Return to thy studies!",      high: "Verily, thy brilliance doth shine like the morning star!" },
        coach:       { low: "That score is NOT acceptable! Get up and TRAIN HARDER! You got this!",      high: "INCREDIBLE! You crushed it! That's the CHAMPION mentality!" },
        conspiracy:  { low: "They don't want you to know the answers. But now you must dig deeper...",   high: "You know too much. They will be watching you now. Well done." },
        ramsay:      { low: "This score is RAW! It's bloody awful! Get back in that kitchen and study!", high: "Finally, someone who actually knows what they're doing. STUNNING!" },
        zen:         { low: "The path to knowledge is long. Breathe, reflect, and begin again.",         high: "Still waters run deep. Your mind is a tranquil lake of wisdom." },
        drill:       { low: "PATHETIC, RECRUIT! DROP AND GIVE ME 20 STUDY SESSIONS! DISMISSED!",         high: "Outstanding performance, soldier! You are an asset to this unit!" },
      };
      const defs = fallbacks[state.personality] || fallbacks.standard;
      roastContent = isGood ? defs.high : defs.low;
    }

    roastText.textContent = roastContent;
    roastContainer.classList.remove('hidden');
    
    // Read the roast aloud after a short delay
    setTimeout(() => speakQuestion(`Evaluation: ${roastContent}`), 1000);
  }

  if (pct >= 80 && window.confetti) {
    confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
  }
  
  speakQuestion("Quiz complete! " + title + " " + subtitle);
}

function buildReview() {
  const list = document.getElementById('reviewList');
  if (!list) return; // safety guard — element must exist in HTML
  list.innerHTML = '';
  state.questions.forEach((q, i) => {
    const ua = state.userAnswers[i];
    const ok = ua === q.correctAnswer;
    const timedOut = ua === null;
    const div = document.createElement('div');
    div.className = `review-item ${ok ? 'correct' : 'incorrect'}`;
    const uaText = timedOut ? '⏰ Timed out' : ua ? `${ua}: ${q.options[ua]}` : 'Not answered';
    div.innerHTML = `
      <div class="review-item-header">
        <div class="review-icon">${ok ? '✅' : timedOut ? '⏰' : '❌'}</div>
        <div class="review-q-text">Q${i + 1}: ${q.question}</div>
      </div>
      <div class="review-answers">
        <div><span class="review-label">Your Answer:</span> <span class="${ok ? 'text-success' : 'text-error'}">${uaText}</span></div>
        ${!ok ? `<div><span class="review-label">Correct:</span> <span class="text-success">${q.correctAnswer}: ${q.options[q.correctAnswer]}</span></div>` : ''}
      </div>
      ${q.explanation ? `<div class="review-explanation">💡 ${q.explanation}</div>` : ''}
    `;
    list.appendChild(div);
  });
}

function retakeQuiz() {
  state.userAnswers = {}; state.score = 0; state.currentIndex = 0;
  buildQuestionDots(); showQuestion(0); showScreen('quiz'); startGlobalTimer();
}

function newQuiz() {
  stopGlobalTimer(); stopCountdown();
  state.questions = []; state.currentIndex = 0; state.userAnswers = {}; state.score = 0;
  state.selectedFile = null; state.timerSeconds = 0;
  document.getElementById('topicInput').value = '';
  document.getElementById('pdfInput').value = '';
  document.getElementById('urlInput').value = '';
  setUrlStatus('', 'hidden');
  document.getElementById('fileInfo').classList.add('hidden');
  document.getElementById('dropZone').classList.remove('hidden');
  switchMode('text'); selectDifficulty('medium'); selectTimeLimit(30);
  state.questionCount = 5; document.getElementById('questionCountDisplay').textContent = '5';
  showScreen('input');
}

// ══ TOAST ═════════════════════════════════════════════════
let _toastTimer = null;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast'), m = document.getElementById('toastMessage');
  if (!t || !m) return;
  m.textContent = msg; t.className = `toast toast-${type}`;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
}

// ══ DATABASE: Save & History ═══════════════════════════════

async function saveQuizSession(pct) {
  try {
    const payload = {
      topic:         state.quizTopic || 'Unknown',
      source:        state.mode,
      difficulty:    state.difficulty,
      questionCount: state.questions.length,
      score:         state.score,
      percentage:    pct,
      timeTaken:     state.timerSeconds,
      questions:     state.questions,
      userAnswers:   state.userAnswers,
    };
    const res = await apiFetch('/api/save-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.success) {
      state.sessionId = data.sessionId;
      // Show XP Pop
      triggerXpPop(data.xpEarned, data.levelInfo);
      
      // Quest Completion Toasts
      if (data.completedQuests && data.completedQuests.length > 0) {
        data.completedQuests.forEach((q, i) => {
          setTimeout(() => {
            showToast(`🎯 Quest Completed: ${q.title} (+${q.xp} XP)`, 'success');
            if (window.confetti) {
              confetti({ particleCount: 50, angle: 60, spread: 55, origin: { x: 0 } });
              confetti({ particleCount: 50, angle: 120, spread: 55, origin: { x: 1 } });
            }
          }, 1000 + (i * 1500));
        });
      }

      // Refresh Auth stats in background
      checkAuth();
    }
  } catch (e) {
    console.warn('Could not save quiz session:', e.message);
  }
}

function triggerXpPop(xp, levelInfo) {
  const overlay = document.getElementById('xpSummaryOverlay');
  const amount  = document.getElementById('xpGainedAmount');
  const lvlMsg  = document.getElementById('xpLevelUpMsg');
  if(!overlay || !amount) return;

  overlay.classList.remove('hidden');
  amount.textContent = `+${xp} XP`;
  amount.classList.add('pop');
  
  if (levelInfo && _user && levelInfo.level > _user.level) {
    lvlMsg.textContent = `LEVEL UP! ${levelInfo.title} 🌟`;
    lvlMsg.classList.remove('hidden');
    lvlMsg.classList.add('pop');
  }

  setTimeout(() => {
    amount.classList.remove('pop');
    if (lvlMsg) { lvlMsg.classList.remove('pop'); lvlMsg.classList.add('hidden'); }
    overlay.classList.add('hidden');
  }, 4000);
}

// ── History Panel ──────────────────────────────────────────
let historyOpen = false;

function toggleHistory() {
  historyOpen = !historyOpen;
  const panel = document.getElementById('historyPanel');
  const overlay = document.getElementById('historyOverlay');
  if (!panel) return;
  if (historyOpen) {
    panel.classList.add('open');
    overlay.classList.remove('hidden');
    loadHistory();
  } else {
    panel.classList.remove('open');
    overlay.classList.add('hidden');
  }
}

async function loadHistory() {
  const list = document.getElementById('historyList');
  const stats = document.getElementById('historyStats');
  if (!list) return;
  list.innerHTML = '<div class="history-loading">Loading...</div>';

  try {
    const [histRes, statsRes] = await Promise.all([
      apiFetch('/api/history?limit=20'),
      apiFetch('/api/stats'),
    ]);
    const histData  = await histRes.json();
    const statsData = await statsRes.json();

    // Stats bar
    if (stats && statsData.success && statsData.stats) {
      const s = statsData.stats;
      stats.innerHTML = `
        <div class="hstat"><span class="hstat-val">${s.totalQuizzes || 0}</span><span class="hstat-label">Quizzes</span></div>
        <div class="hstat"><span class="hstat-val">${parseInt(s.avgScore) || 0}%</span><span class="hstat-label">Avg Score</span></div>
        <div class="hstat"><span class="hstat-val">${parseInt(s.bestScore) || 0}%</span><span class="hstat-label">Best</span></div>
        <div class="hstat"><span class="hstat-val">${s.totalQuestions || 0}</span><span class="hstat-label">Questions</span></div>
      `;
    }

    // History list
    if (!histData.success || !histData.history.length) {
      list.innerHTML = '<div class="history-empty">📭 No quiz history yet.<br>Complete a quiz to see it here!</div>';
      return;
    }

    list.innerHTML = '';
    histData.history.forEach(session => {
      const card = document.createElement('div');
      card.className = 'history-card';
      const pct = session.percentage || 0;
      const colour = pct >= 80 ? 'success' : pct >= 60 ? 'warning' : 'error';
      const srcIcon = session.source === 'pdf' ? '📄' : session.source === 'url' ? '🌐' : '✏️';
      const date = new Date(session.createdAt).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
      const diffLabel = { easy: '📗 Easy', medium: '📙 Medium', hard: '📕 Hard' }[session.difficulty] || session.difficulty;

      card.innerHTML = `
        <div class="hcard-header">
          <div class="hcard-score hcard-score-${colour}">${pct}%</div>
          <div class="hcard-meta">
            <div class="hcard-topic">${srcIcon} ${(session.topic || 'Unknown').substring(0, 50)}</div>
            <div class="hcard-sub">${diffLabel} · ${session.questionCount} Qs · ${session.score}/${session.questionCount} correct · ${date}</div>
          </div>
          <button class="hcard-delete" onclick="deleteHistoryItem('${session._id}', this)" title="Delete">🗑</button>
        </div>
      `;
      list.appendChild(card);
    });

    try {
      if(histData.history && histData.history.length > 0) renderAnalytics(histData.history);
    } catch(err) {
      console.error('Analytics rendering error:', err);
    }
  } catch (e) {
    list.innerHTML = `<div class="history-empty">⚠️ Could not load history.<br>${e.message}</div>`;
  }
}

function switchHistoryTab(tab) {
  const hsTab = document.getElementById('tabBtnHistory');
  const anTab = document.getElementById('tabBtnAnalytics');
  const hsView = document.getElementById('historyList');
  const anView = document.getElementById('analyticsView');
  if(!hsTab || !anTab) return;
  
  if (tab === 'hs') {
    hsTab.style.borderBottom = '2px solid var(--accent-primary)';
    hsTab.style.color = '#fff';
    anTab.style.borderBottom = 'none';
    anTab.style.color = 'var(--text-muted)';
    hsView.classList.remove('hidden');
    anView.classList.add('hidden');
  } else {
    anTab.style.borderBottom = '2px solid var(--accent-primary)';
    anTab.style.color = '#fff';
    hsTab.style.borderBottom = 'none';
    hsTab.style.color = 'var(--text-muted)';
    anView.classList.remove('hidden');
    hsView.classList.add('hidden');
  }
}

let _xpChartInstance = null;
let _radarChartInstance = null;

function renderAnalytics(history) {
  if (!window.Chart) return;
  const xpCtx = document.getElementById('xpChart');
  const radarCtx = document.getElementById('radarChart');
  if(!xpCtx || !radarCtx) return;

  const reversed = [...history].reverse();
  const labels = reversed.map((_, i) => 'Quiz ' + (i+1));
  const dataScores = reversed.map(h => h.percentage);

  Chart.defaults.color = '#9ca3af';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.1)';

  if (_xpChartInstance) _xpChartInstance.destroy();
  _xpChartInstance = new Chart(xpCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Accuracy %',
        data: dataScores,
        borderColor: '#8b5cf6',
        backgroundColor: 'rgba(139, 92, 246, 0.2)',
        tension: 0.4,
        fill: true,
      }]
    },
    options: { plugins: { legend: { display: false }, title: { display: true, text: 'Recent Performance' } } }
  });

  let eS=0, eC=0, mS=0, mC=0, hS=0, hC=0;
  history.forEach(h => {
    if(h.difficulty==='easy') { eS+=h.percentage; eC++; }
    if(h.difficulty==='medium') { mS+=h.percentage; mC++; }
    if(h.difficulty==='hard') { hS+=h.percentage; hC++; }
  });

  if (_radarChartInstance) _radarChartInstance.destroy();
  _radarChartInstance = new Chart(radarCtx, {
    type: 'radar',
    data: {
      labels: ['Easy', 'Medium', 'Hard'],
      datasets: [{
        label: 'Avg Accuracy',
        data: [eC?eS/eC:0, mC?mS/mC:0, hC?hS/hC:0],
        borderColor: '#ec4899',
        backgroundColor: 'rgba(236, 72, 153, 0.3)',
      }]
    },
    options: { scales: { r: { min: 0, max: 100, ticks: { display: false } }, angleLines: { color: 'rgba(255,255,255,0.1)' }, grid: { color: 'rgba(255,255,255,0.1)' } }, plugins: { title: { display: true, text: 'Difficulty Mastery' } } }
  });
}

async function deleteHistoryItem(id, btn) {
  if (!confirm('Delete this quiz from history?')) return;
  try {
    await apiFetch(`/api/history/${id}`, { method: 'DELETE' });
    btn.closest('.history-card').remove();
    loadHistory(); // refresh stats
  } catch (e) {
    showToast('Could not delete item', 'error');
  }
}

// ── Leaderboard Panel ──────────────────────────────────────
let leaderboardOpen = false;

function toggleLeaderboard() {
  leaderboardOpen = !leaderboardOpen;
  const panel = document.getElementById('leaderboardPanel');
  const overlay = document.getElementById('historyOverlay'); // reuse overlay
  if (!panel) return;
  
  if (historyOpen) toggleHistory(); // close history if open

  if (leaderboardOpen) {
    panel.classList.add('open');
    overlay.classList.remove('hidden');
    loadLeaderboard();
  } else {
    panel.classList.remove('open');
    if (!historyOpen) overlay.classList.add('hidden');
  }
}

async function loadLeaderboard() {
  const list = document.getElementById('leaderboardList');
  if (!list) return;
  list.innerHTML = '<div class="history-loading">Fetching global ranks...</div>';

  try {
    const res = await apiFetch('/api/auth/leaderboard');
    const data = await res.json();

    if (!data.success || !data.leaderboard.length) {
      list.innerHTML = '<div class="history-empty">No players yet. Be the first!</div>';
      return;
    }

    list.innerHTML = '';
    data.leaderboard.forEach((player, i) => {
      const card = document.createElement('div');
      card.className = 'history-card' + (player.username === _user?.username ? ' current-user' : '');
      
      let rankIcon = `#${i+1}`;
      if (i === 0) rankIcon = '🥇';
      if (i === 1) rankIcon = '🥈';
      if (i === 2) rankIcon = '🥉';

      card.innerHTML = `
        <div class="hcard-header">
          <div class="hcard-score" style="font-size: 1.2rem;">${rankIcon}</div>
          <div class="hcard-meta">
            <div class="hcard-topic"><b style="color:var(--text-primary);">${player.username}</b> <span style="color:var(--accent-primary);font-size:0.75rem;">Lvl ${player.level} ${player.levelTitle}</span></div>
            <div class="hcard-sub">${player.xp.toLocaleString()} XP · ${player.totalQuizzes} Quizzes · ${player.avgScore}% Avg</div>
          </div>
          ${player.streak > 1 ? '<div style="flex-shrink:0;color:#f97316;font-size:1.1rem" title="Streak">🔥'+player.streak+'</div>' : ''}
        </div>
      `;
      list.appendChild(card);
    });
  } catch (e) {
    list.innerHTML = `<div class="history-empty">⚠️ Could not load leaderboard.</div>`;
  }
}


function setUrlStatus(msg, type) {
  const el = document.getElementById('urlFetchStatus');
  if (!el) return;
  if (type === 'hidden' || !msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.className = 'url-fetch-status url-status-' + type;
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function deleteHistoryItem(id, btn) {
  if (!confirm('Delete this quiz from history?')) return;
  try {
    const res = await apiFetch(`/api/history/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      const card = btn.closest('.history-card');
      if (card) {
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 300);
      }
      showToast('Session deleted.', 'success');
    }
  } catch (e) {
    showToast('Error deleting item: ' + e.message, 'error');
  }
}

async function shareResults() {
  const pctEl = document.getElementById('scorePercentage');
  const pct = pctEl ? pctEl.textContent : '0%';
  const topic = state.quizTopic || 'Quiz';
  const roastEl = document.getElementById('aiRoastText');
  const roast = roastEl ? roastEl.textContent : '';
  
  const text = `I just crushed a quiz on "${topic}" with ${pct} accuracy! 🚀\n\nAI Twin Eval: "${roast}"\n\nBeat me on QuizAI!`;
  const url = window.location.href;

  if (navigator.share) {
    try {
      await navigator.share({ title: 'QuizAI Rank', text, url });
      showToast('Shared successfully!', 'success');
      return;
    } catch (e) {
      console.warn('Share API failed:', e);
    }
  }

  // Fallback: Clipboard
  try {
    const fullText = `${text}\n${url}`;
    await navigator.clipboard.writeText(fullText);
    showToast('Rank copied to clipboard! Share it everywhere! 📋', 'success');
  } catch (err) {
    console.error('Copy failed:', err);
    showToast('Could not copy results. Try manually selecting text.', 'error');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══ PARTICLE BACKGROUND ═══════════════════════════════════
(function () {
  const canvas = document.getElementById('bgCanvas');
  const spotlight = document.getElementById('bgSpotlight');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const LINK = 130, MR = 200;
  let parts = [], mouse = { x: -1000, y: -1000 };

  class P {
    constructor(w, h) {
      this.x = Math.random() * w; this.y = Math.random() * h;
      this.s = Math.random() * 2.5 + 1;
      this.vx = (Math.random() - .5) * .7; this.vy = (Math.random() - .5) * .7;
      this.o = Math.random() * .4 + .1;
    }
    update(w, h, mx, my) {
      this.x += this.vx; this.y += this.vy;
      if (this.x < 0) this.x = w; if (this.x > w) this.x = 0;
      if (this.y < 0) this.y = h; if (this.y > h) this.y = 0;
      if (mx !== -1000) { const dx = mx - this.x, dy = my - this.y, d = Math.hypot(dx, dy); if (d < MR) { const f = (MR - d) / MR * .012; this.vx -= dx * f; this.vy -= dy * f; } }
      this.vx *= .999; this.vy *= .999;
      if (Math.hypot(this.vx, this.vy) < .15) { this.vx += (Math.random() - .5) * .3; this.vy += (Math.random() - .5) * .3; }
    }
    draw(c) { c.beginPath(); c.arc(this.x, this.y, this.s, 0, Math.PI * 2); c.fillStyle = `rgba(139,92,246,${this.o})`; c.fill(); }
  }

  function resize() {
    canvas.width = innerWidth; canvas.height = innerHeight;
    parts = []; const n = innerWidth < 768 ? 50 : 80;
    for (let i = 0; i < n; i++) parts.push(new P(canvas.width, canvas.height));
  }

  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', e => {
    mouse.x = e.clientX; mouse.y = e.clientY;
    if (spotlight) { spotlight.style.background = `radial-gradient(circle 500px at ${e.clientX}px ${e.clientY}px,rgba(139,92,246,0.08),transparent)`; spotlight.style.opacity = '1'; }
  });
  document.body.addEventListener('mouseleave', () => { mouse.x = -1000; mouse.y = -1000; if (spotlight) spotlight.style.opacity = '0'; });
  resize();

  (function anim() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < parts.length; i++) {
      parts[i].update(canvas.width, canvas.height, mouse.x, mouse.y);
      parts[i].draw(ctx);
      for (let j = i + 1; j < parts.length; j++) {
        const dx = parts[i].x - parts[j].x, dy = parts[i].y - parts[j].y, d = Math.hypot(dx, dy);
        if (d < LINK) { ctx.beginPath(); const o = 1 - d / LINK; ctx.strokeStyle = `rgba(139,92,246,${o * .15})`; ctx.lineWidth = o * 1.2; ctx.moveTo(parts[i].x, parts[i].y); ctx.lineTo(parts[j].x, parts[j].y); ctx.stroke(); }
      }
      if (mouse.x !== -1000) {
        const dx = parts[i].x - mouse.x, dy = parts[i].y - mouse.y, d = Math.hypot(dx, dy);
        if (d < MR) { ctx.beginPath(); const o = 1 - d / MR; ctx.strokeStyle = `rgba(139,92,246,${o * .3})`; ctx.lineWidth = o * 1.8; ctx.moveTo(parts[i].x, parts[i].y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke(); }
      }
    }
    requestAnimationFrame(anim);
  })();
})();

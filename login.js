// ── Auth Routing & UI ──

document.addEventListener('DOMContentLoaded', () => {
  // If already logged in, redirect to app
  if (localStorage.getItem('quizai_token')) {
    window.location.href = '/';
  }

  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('registerForm').addEventListener('submit', handleRegister);
  
  createStars();
});

function toggleAuth(mode) {
  const loginForm = document.getElementById('loginFormContainer');
  const regForm = document.getElementById('registerFormContainer');
  
  if (mode === 'register') {
    loginForm.classList.add('hidden');
    regForm.classList.remove('hidden');
    regForm.style.animation = 'none';
    regForm.offsetHeight; /* trigger reflow */
    regForm.style.animation = null;
  } else {
    regForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
    loginForm.style.animation = 'none';
    loginForm.offsetHeight; 
    loginForm.style.animation = null;
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = 'Connecting...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('loginEmail').value,
        password: document.getElementById('loginPassword').value
      })
    });
    
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('quizai_token', data.token);
      localStorage.setItem('quizai_user', JSON.stringify(data.user));
      showToast('Logged in successfully! Redirecting...', 'success');
      setTimeout(() => window.location.href = '/', 800);
    } else {
      showToast(data.error || 'Login failed', 'error');
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  } catch (err) {
    showToast('Network error', 'error');
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = 'Creating Account...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('regUsername').value,
        email: document.getElementById('regEmail').value,
        password: document.getElementById('regPassword').value
      })
    });
    
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('quizai_token', data.token);
      localStorage.setItem('quizai_user', JSON.stringify(data.user));
      showToast('Account created! Redirecting...', 'success');
      setTimeout(() => window.location.href = '/', 800);
    } else {
      showToast(data.error || 'Registration failed', 'error');
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  } catch (err) {
    showToast('Network error', 'error');
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

// Reuse toast logic
let _toastTimer;
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  const tm = document.getElementById('toastMessage');
  if(!t) return alert(msg);
  tm.textContent = msg;
  t.className = `toast toast-${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
}

// Background stars
function createStars() {
  const c = document.getElementById('stars');
  if(!c) return;
  for(let i=0; i<30; i++) {
    const s = document.createElement('div');
    s.style.position = 'absolute';
    s.style.left = Math.random()*100+'%';
    s.style.top = Math.random()*100+'%';
    s.style.width = Math.random()*3+'px';
    s.style.height = s.style.width;
    s.style.background = '#fff';
    s.style.borderRadius = '50%';
    s.style.opacity = Math.random()*0.5;
    s.style.animation = `twinkle ${2+Math.random()*3}s infinite`;
    c.appendChild(s);
  }
}

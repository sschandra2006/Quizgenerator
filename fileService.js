const fs = require('fs');
const pdfParseLib = require('pdf-parse');
const PDFParser = require('pdf2json');

class FileService {
  /**
   * Extract text from an uploaded PDF with multiple parser fallback
   */
  async extractText(filePath) {
    try {
      console.log(`[FileService] Attempting pdf-parse extraction...`);
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParseLib(dataBuffer);
      let text = data.text;

      // If empty, try fallback
      if (!text || text.trim().length < 20) {
        throw new Error('Fallback trigger');
      }

      return this._cleanText(text);
    } catch (error) {
      console.log(`[FileService] Falling back to pdf2json parser...`);
      try {
        const text = await this._extractWithPdf2Json(filePath);
        if (!text || text.trim().length < 20) {
          throw new Error('PDF is fully empty or contains only scan images.');
        }
        return this._cleanText(text);
      } catch (fallbackError) {
        throw new Error(`The PDF appears to be a scanned image or is empty. Please try "Enter Topic" mode instead!`);
      }
    } finally {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}
    }
  }

  _cleanText(text) {
    return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  _extractWithPdf2Json(filePath) {
    return new Promise((resolve, reject) => {
      const pdfParser = new PDFParser(this, 1);
      
      pdfParser.on("pdfParser_dataError", errData => reject(errData.parserError));
      pdfParser.on("pdfParser_dataReady", pdfData => {
        const text = pdfParser.getRawTextContent();
        resolve(text);
      });

      pdfParser.loadPDF(filePath);
    });
  }
}

module.exports = new FileService();

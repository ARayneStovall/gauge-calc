import { useState } from 'react'
import './App.css'

// Set VITE_API_URL in the deployed environment to point at the hosted
// backend; falls back to the local dev server when unset.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function App() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [knitterGaugeSts, setKnitterGaugeSts] = useState(0);
  const [knitterGaugeRow, setKnitterGaugeRow] = useState(0);
  const [preferredSize, setPreferredSize] = useState('3');
  const [stampDx, setStampDx] = useState(0);

  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    var file = event.target.files?.[0];
    setPdfFile(file ?? null);
  }

  function handleStsChange(event: React.ChangeEvent<HTMLInputElement>) {
    setKnitterGaugeSts(Number(event.target.value));
  }

  function handleRowChange(event: React.ChangeEvent<HTMLInputElement>) {
    setKnitterGaugeRow(Number(event.target.value));
  }

  function handlePreferredSizeChange(event: React.ChangeEvent<HTMLInputElement>) {
    setPreferredSize(event.target.value);
  }

  function handleStampDxChange(event: React.ChangeEvent<HTMLInputElement>) {
    setStampDx(Number(event.target.value));
  }



  async function handleSubmit() {
    if (pdfFile === null) {
        return;
    }
    try {
      setError(null);
      setLoading(true);
      console.log('Submitting PDF', { name: pdfFile.name, size: pdfFile.size, knitterGaugeSts, knitterGaugeRow });
      var formData = new FormData();
      formData.append("pdf", pdfFile);
      formData.append("knitterGaugeSts", String(knitterGaugeSts));
      formData.append("knitterGaugeRow", String(knitterGaugeRow));
      formData.append("preferredSize", String(preferredSize));
      formData.append("stampDx", String(stampDx));


      var response = await fetch(`${API_URL}/api/rescale`, {
          method: "POST",
          body: formData,
      });

      console.log('Response status', response.status, response.headers.get('content-type'));
      if (!response.ok) {
        const text = await response.text().catch(() => 'no body');
        throw new Error(`Server error: ${response.status} ${text}`);
      }

      var pdfBlob = await response.blob();
      var url = URL.createObjectURL(pdfBlob);
      setDownloadUrl(url);

      // auto-download
      const a = document.createElement('a');
      a.href = url;
      a.download = 'rescaled-pattern.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      console.log('Downloaded rescaled PDF');
    } catch (err: any) {
      console.error('Recalculate failed', err);
      setError(err?.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }


  return (
    <div>
      <button onClick={handleSubmit}>Recalculate</button>
      {loading && <span>Processing…</span>}
      {error && <div style={{ color: 'red' }}>{error}</div>}
      <input type="file" accept="application/pdf" onChange={handleFileChange} />
      <label>Stitches gauge <input type="number" value={knitterGaugeSts} onChange={handleStsChange} /></label>
      <label>Rows gauge <input type="number" value={knitterGaugeRow} onChange={handleRowChange} /></label>
      <label>Preferred size label <input type="text" value={preferredSize} onChange={handlePreferredSizeChange} /></label>
      <label>Stamp X offset <input type="number" value={stampDx} onChange={handleStampDxChange} /></label>

      {downloadUrl !== null && (
        <a href={downloadUrl} download="rescaled-pattern.pdf">Download</a>
      )}
    </div>
  );

}

export default App

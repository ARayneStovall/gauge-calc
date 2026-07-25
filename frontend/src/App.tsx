import { useState } from 'react'
import './App.css'

// Set VITE_API_URL in the deployed environment to point at the hosted
// backend; falls back to the local dev server when unset.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function App() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  // Tracked as strings (not numbers) starting empty rather than "0" — a
  // controlled number input defaulting to 0 shows a lingering leading zero
  // while typing (e.g. "022") that only clears via the spinner arrows.
  const [knitterGaugeSts, setKnitterGaugeSts] = useState('');
  const [knitterGaugeRow, setKnitterGaugeRow] = useState('');
  // Empty by default (not pre-filled "3") to match the gauge fields above —
  // the backend already falls back to "3" when this is left blank.
  const [preferredSize, setPreferredSize] = useState('');

  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    var file = event.target.files?.[0];
    setPdfFile(file ?? null);
  }

  function handleStsChange(event: React.ChangeEvent<HTMLInputElement>) {
    setKnitterGaugeSts(event.target.value);
  }

  function handleRowChange(event: React.ChangeEvent<HTMLInputElement>) {
    setKnitterGaugeRow(event.target.value);
  }

  function handlePreferredSizeChange(event: React.ChangeEvent<HTMLInputElement>) {
    setPreferredSize(event.target.value);
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
    <div className="page">
      <div className="card">
        <h1>gaugeCalc</h1>
        <p className="subtitle">Upload a pattern PDF and your gauge to get the stitch and row counts recalculated for you.</p>

        <div className="field">
          <label htmlFor="pdf-input">Pattern PDF</label>
          <input id="pdf-input" type="file" accept="application/pdf" onChange={handleFileChange} />
          {pdfFile && <span className="file-name">{pdfFile.name}</span>}
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="sts-input">Stitches / 4in</label>
            <input id="sts-input" type="number" placeholder="e.g. 22" value={knitterGaugeSts} onChange={handleStsChange} />
          </div>
          <div className="field">
            <label htmlFor="row-input">Rows / 4in</label>
            <input id="row-input" type="number" placeholder="e.g. 30" value={knitterGaugeRow} onChange={handleRowChange} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="size-input">Preferred size label</label>
          <input id="size-input" type="text" placeholder="e.g. 3 or M" value={preferredSize} onChange={handlePreferredSizeChange} />
        </div>

        <button className="primary-button" onClick={handleSubmit} disabled={loading || pdfFile === null}>
          {loading ? 'Processing…' : 'Recalculate'}
        </button>

        {error && <div className="error-banner">{error}</div>}

        {downloadUrl !== null && (
          <a className="download-link" href={downloadUrl} download="rescaled-pattern.pdf">Download rescaled pattern</a>
        )}
      </div>
    </div>
  );

}

export default App

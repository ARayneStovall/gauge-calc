import { useState } from 'react'
import './App.css'

function App() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [knitterGauge, setKnitterGauge] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    var file = event.target.files?.[0];
    setPdfFile(file ?? null);
  }

  function handleGaugeChange(event: React.ChangeEvent<HTMLInputElement>) {
    setKnitterGauge(Number(event.target.value));
  }

  async function handleSubmit() {
    if (pdfFile === null) {
        return;
    }

    var formData = new FormData();
    formData.append("pdf", pdfFile);
    formData.append("knitterGauge", String(knitterGauge));

    var response = await fetch("http://localhost:3001/api/rescale", {
        method: "POST",
        body: formData,
    });

    var pdfBlob = await response.blob();
    var url = URL.createObjectURL(pdfBlob);
    setDownloadUrl(url);
  }


  return (
    <div>
      <button onClick={handleSubmit}>Recalculate</button>
      <input type="file" accept="application/pdf" onChange={handleFileChange} />
      <input type="number" value={knitterGauge} onChange={handleGaugeChange} />
      {downloadUrl !== null && (
        <a href={downloadUrl} download="rescaled-pattern.pdf">Download</a>
      )}
    </div>
  );

}

export default App

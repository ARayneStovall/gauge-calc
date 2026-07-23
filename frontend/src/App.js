import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import './App.css';
function App() {
    const [pdfFile, setPdfFile] = useState(null);
    const [knitterGauge, setKnitterGauge] = useState(0);
    function handleFileChange(event) {
        var file = event.target.files?.[0];
        setPdfFile(file ?? null);
    }
    function handleGaugeChange(event) {
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
        console.log(response);
    }
    return (_jsxs("div", { children: [_jsx("button", { onClick: handleSubmit, children: "Recalculate" }), _jsx("input", { type: "file", accept: "application/pdf", onChange: handleFileChange }), _jsx("input", { type: "number", value: knitterGauge, onChange: handleGaugeChange })] }));
}
export default App;
//# sourceMappingURL=App.js.map
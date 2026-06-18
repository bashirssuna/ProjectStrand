"use client";
import { useEffect, useRef, useState } from "react";

// A DocuSign-style signature field for embedding in any form. Captures either a
// freehand drawing or a typed name (rendered in a script font) and writes a PNG
// data URL into a hidden input, so stored signatures are a uniform image that
// prints everywhere. Distinct from the profile SignaturePad (which is bespoke).
export function SignField({
  name = "signature",
  width = 460,
  height = 150,
  initialName = "",
}: {
  name?: string;
  width?: number;
  height?: number;
  initialName?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [typed, setTyped] = useState(initialName);

  const ctx = () => {
    const c = canvasRef.current;
    if (!c) return null;
    const g = c.getContext("2d");
    if (g) { g.lineWidth = 2.2; g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = "#1a2a4a"; }
    return g;
  };
  const sync = () => {
    const c = canvasRef.current;
    if (c && hiddenRef.current) hiddenRef.current.value = dirty.current ? c.toDataURL("image/png") : "";
  };
  const clear = () => {
    const c = canvasRef.current, g = ctx();
    if (c && g) g.clearRect(0, 0, c.width, c.height);
    dirty.current = false; sync();
  };
  const pos = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  const down = (e: React.PointerEvent) => {
    if (mode !== "draw") return;
    e.preventDefault();
    drawing.current = true; dirty.current = true; last.current = pos(e);
    canvasRef.current?.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current || mode !== "draw") return;
    const g = ctx(); if (!g || !last.current) return;
    const p = pos(e);
    g.beginPath(); g.moveTo(last.current.x, last.current.y); g.lineTo(p.x, p.y); g.stroke();
    last.current = p;
  };
  const up = () => { drawing.current = false; last.current = null; sync(); };

  useEffect(() => {
    if (mode !== "type") return;
    const c = canvasRef.current, g = ctx();
    if (!c || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    const txt = typed.trim();
    if (txt) {
      g.fillStyle = "#1a2a4a";
      g.font = "44px 'Segoe Script','Brush Script MT',cursive";
      g.textBaseline = "middle";
      g.fillText(txt, 18, c.height / 2);
      dirty.current = true;
    } else { dirty.current = false; }
    sync();
  }, [typed, mode]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-1 text-xs flex-wrap">
        <button type="button" onClick={() => { setMode("draw"); clear(); }} className={mode === "draw" ? "btn btn-sm btn-primary" : "btn btn-sm"}>Draw</button>
        <button type="button" onClick={() => setMode("type")} className={mode === "type" ? "btn btn-sm btn-primary" : "btn btn-sm"}>Type</button>
        <button type="button" onClick={() => { if (mode === "type") setTyped(""); else clear(); }} className="btn btn-sm">Clear</button>
        <span style={{ color: "var(--muted)" }}>{mode === "draw" ? "Sign with your mouse or finger" : "Type your name as your signature"}</span>
      </div>
      {mode === "type" && (
        <input className="input mb-1" placeholder="Type your full name" value={typed} onChange={(e) => setTyped(e.target.value)}
          style={{ fontFamily: "'Segoe Script','Brush Script MT',cursive", fontSize: 22 }} />
      )}
      <canvas ref={canvasRef} width={width} height={height}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
        style={{ width: "100%", maxWidth: width, height, border: "1px solid var(--border)", borderRadius: 8, background: "#fff", touchAction: "none", cursor: mode === "draw" ? "crosshair" : "default" }} />
      <input ref={hiddenRef} type="hidden" name={name} defaultValue="" />
    </div>
  );
}

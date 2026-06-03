"use client";
import { useRef, useState, useEffect } from "react";
import { saveSignatureAction } from "@/app/actions";

export function SignaturePad({ existing }: { existing: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [dataUrl, setDataUrl] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1a1a1a";
  }, []);

  const pos = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const start = (e: React.PointerEvent) => {
    setDrawing(true);
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = pos(e);
    ctx.beginPath(); ctx.moveTo(x, y);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = pos(e);
    ctx.lineTo(x, y); ctx.stroke();
    setDirty(true);
  };
  const end = () => {
    setDrawing(false);
    if (canvasRef.current) setDataUrl(canvasRef.current.toDataURL("image/png"));
  };
  const clear = () => {
    const c = canvasRef.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setDataUrl(""); setDirty(false);
  };

  return (
    <div className="space-y-3">
      {existing && (
        <div>
          <div className="label">Current signature</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={existing} alt="current signature" className="h-16 border rounded bg-white" style={{ borderColor: "var(--border)" }} />
        </div>
      )}
      <div className="label">Draw a new signature</div>
      <canvas
        ref={canvasRef} width={460} height={140}
        className="border rounded bg-white touch-none w-full"
        style={{ borderColor: "var(--border)", maxWidth: 460 }}
        onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerLeave={end}
      />
      <form action={saveSignatureAction} className="flex items-center gap-2">
        <input type="hidden" name="dataUrl" value={dataUrl} />
        <button className="btn btn-primary btn-sm" type="submit" disabled={!dirty}>Save signature</button>
        <button type="button" className="btn btn-sm" onClick={clear}>Clear</button>
      </form>
    </div>
  );
}

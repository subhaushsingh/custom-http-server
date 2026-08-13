import { useState, useRef, useEffect } from "react";

const COLOR = {
  bgFlat: "#17140F",
  panel: "#1E1A15",
  panel2: "#141110",
  border: "#332C22",
  borderSoft: "#28221B",
  text: "#F4EFE6",
  muted: "#A79C8B",
  dim: "#655C4E",
  green: "#8FEAA9",
  greenSoft: "rgba(143,234,169,0.08)",
  cream: "#F4EFE6",
  coral: "#FF7B72",
  amber: "#FEBC2E",
  terminalBg: "#222120", 
};

const FONT_DISPLAY = "'Space Grotesk', sans-serif";
const FONT_BODY = "'Inter', sans-serif";
const FONT_MONO = "'IBM Plex Mono', monospace";

const FEATURE_TEMPLATES = [
  {
    title: "Static file serving",
    code: "200",
    desc: "Standard file serving and MIME type resolution.",
    method: "GET",
    path: "/files/test.txt",
    headers: "Accept: */*",
    body: "",
    doc: "The router strips the '/files/' prefix, locates 'test.txt' in the www/ directory, and uses fs.stat() to determine the file size. It maps the '.txt' extension to the 'text/plain' MIME type and streams the file to the socket."
  },
  {
    title: "HTTP caching",
    code: "304",
    desc: "Conditional requests, to save bandwidth on unchanged files.",
    method: "GET",
    path: "/files/test.txt",
    headers: "If-Modified-Since: Wed, 21 Oct 2030 07:28:00 GMT\nAccept: */*",
    body: "",
    doc: "By sending 'If-Modified-Since', the client asks whether the file has changed since that date. If it hasn't, the server aborts the file read and sends a 304 Not Modified header with no body."
  },
  {
    title: "Partial content",
    code: "206",
    desc: "Byte-range requests via parseSingleRange().",
    method: "GET",
    path: "/files/test.txt",
    headers: "Range: bytes=0-5\nAccept: */*",
    body: "",
    doc: "Used for streaming and resumable downloads. Instead of loading the whole file into RAM, fileReader() jumps to the exact byte offset requested and reads only that slice, returning 206 Partial Content."
  },
  {
    title: "Chunked body echo",
    code: "200",
    desc: "Round-trips a chunked-encoded request body.",
    method: "POST",
    path: "/echo",
    headers: "Content-Type: text/plain",
    body: "Line 1: Hello from React\nLine 2: Testing chunked encoding\nLine 3: End of message",
    doc: "The '/echo' route doesn't know its response length ahead of time, so it applies 'Transfer-Encoding: chunked' on the way out, re-encoding the body into hex-sized blocks."
  },
  {
    title: "Async generator stream",
    code: "200",
    desc: "Real-time chunked streaming via /sheep.",
    method: "GET",
    path: "/sheep",
    headers: "",
    body: "",
    doc: "This endpoint yields data over time from an async generator. Since the total size can't be known upfront, the server sets chunked encoding and flushes each yielded line the moment it's produced."
  },
  {
    title: "WebSocket upgrade",
    code: "101",
    desc: "WS masking and framing, echoed back.",
    method: "WS",
    path: "/ws",
    headers: "(WebSockets don't use standard fetch headers)",
    body: "Ping from the frontend!",
    doc: "The client sends an 'Upgrade: websocket' header with a key. The server hashes it against a fixed GUID, replies 101 Switching Protocols, and moves the socket to binary WebSocket framing."
  },
  {
    title: "Method not allowed",
    code: "405",
    desc: "Router rejects invalid methods on static paths.",
    method: "POST",
    path: "/files/test.txt",
    headers: "Content-Type: text/plain",
    body: "Trying to overwrite a file...",
    doc: "If a client sends POST to a static file path, the router intercepts it and returns 405, preventing unauthorized writes to files it only ever meant to read."
  }
];

const DOC_SECTIONS = [
  { id: "sec-tcp", title: "TCP Foundation & Buffer",
    body: "TCP delivers an ordered stream of bytes, not complete HTTP messages. The server maintains a dynamically growing buffer that continuously accumulates incoming bytes until \\r\\n\\r\\n is found. This separation allows request pipelining, partial reads, and efficient memory usage without exposing sockets directly to the application layer." },
  { id: "sec-parser", title: "HTTP Request Parser",
    body: "Every request line and header is parsed manually. Before execution, it strictly validates the HTTP version, method, URI syntax, and header formatting. Malformed input instantly returns the appropriate HTTP error instead of being silently accepted." },
  { id: "sec-bodies", title: "Reading Request Bodies",
    body: "Supports Fixed Length, Chunked Transfer-Encoding, and Empty requests cleanly. Instead of exposing raw buffers, every request body relies on a common BodyReader interface, allowing files, streams, generators, and memory buffers to be processed identically." },
  { id: "sec-pipeline", title: "Response Pipeline",
    body: "Responses are manually assembled. Before transmission, it automatically generates status lines, adds missing Content-Length, switches to chunked encoding for streams, applies CORS, and writes the body. Streaming never requires the payload to fully exist in memory." },
  { id: "sec-compression", title: "On-the-fly Compression",
    body: "If the client advertises Accept-Encoding: gzip, the body is compressed dynamically. No temporary files or intermediate buffers are created—the gzip stream is generated directly as bytes are sent. It safely skips compression for range requests and protocol upgrades." },
  { id: "sec-static", title: "Static File Server",
    body: "Serves files directly from the www/ directory with production-grade features: MIME type detection, Last-Modified caching, If-Modified-Since validation, 206 Partial Content (byte range requests), 304 Not Modified, and directory traversal protection." },
  { id: "sec-streaming", title: "Streaming",
    body: "Responses don't have to exist all at once. Any asynchronous generator can become an HTTP response. The included /sheep endpoint demonstrates incremental streaming where data is produced over time and immediately forwarded to the client." },
  { id: "sec-ws", title: "WebSocket Protocol",
    body: "Implemented straight from the RFC without external libraries. Handles HTTP Upgrade handshakes, SHA-1 key generation, frame parsing, mask removal, ping/pong handling, and both binary and text messages via a clean asynchronous API." },
  { id: "sec-lifecycle", title: "Connection Lifecycle",
    body: "Each TCP connection is processed independently. The server supports HTTP keep-alive, continuous request reading, smooth WebSockets upgrades, and graceful protocol error handling, allowing multiple requests to share a single connection safely." },
];

export default function LiveServerClient() {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/files/test.txt");
  const [headersText, setHeadersText] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [expandedDoc, setExpandedDoc] = useState(null);

  const [logs, setLogs] = useState([]);
  const [isRequesting, setIsRequesting] = useState(false);
  const wsRef = useRef(null);
  const logEndRef = useRef(null);
  const consoleRef = useRef(null);
  const docsRef = useRef(null);

  useEffect(() => {
    if (logs.length > 0) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  const appendLog = (type, msg) => setLogs((prev) => [...prev, { type, msg }]);
  const clearLogs = () => setLogs([]);

  const parseHeaders = (text) => {
    const headers = {};
    text.split('\n').forEach(line => {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        const val = line.substring(idx + 1).trim();
        if (key && val) headers[key] = val;
      }
    });
    return headers;
  };

  const fireRequest = async () => {
    setIsRequesting(true);
    clearLogs();
    const baseUrl = "http://127.0.0.1:1234";

    try {
      if (method === "WS") {
        appendLog("info", `Opening WebSocket to ws://127.0.0.1:1234${path}...`);
        if (wsRef.current) wsRef.current.close();

        const ws = new WebSocket(`ws://127.0.0.1:1234${path}`);
        wsRef.current = ws;

        ws.onopen = () => {
          appendLog("info", "WebSocket Connected!");
          const msg = bodyText || "Hello WS";
          ws.send(msg);
          appendLog("out", msg);
        };

        ws.onmessage = (e) => appendLog("in", `Server replied: ${e.data}`);
        ws.onclose = () => appendLog("info", "WebSocket closed.");
        ws.onerror = () => appendLog("err", "WebSocket error. Check backend.");

        setIsRequesting(false);
        return;
      }

      appendLog("out", `${method} ${path}`);
      const parsedHeaders = parseHeaders(headersText);

      const reqOptions = {
        method,
        headers: parsedHeaders,
        body: (method === "POST" || method === "PUT") ? bodyText : undefined,
      };

      const res = await fetch(`${baseUrl}${path}`, reqOptions);

      appendLog("info", `HTTP ${res.status} ${res.statusText}`);
      res.headers.forEach((val, key) => appendLog("info", `${key}: ${val}`));

      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            appendLog("info", "Stream complete.");
            break;
          }
          appendLog("in", decoder.decode(value).trim());
        }
      } else {
        appendLog("in", await res.text());
      }
    } catch (err) {
      appendLog("err", `Network Error: ${err.message}`);
    } finally {
      setIsRequesting(false);
    }
  };

  const applyTemplate = (t) => {
    setMethod(t.method);
    setPath(t.path);
    setHeadersText(t.headers);
    setBodyText(t.body);
  };

  const toggleDoc = (index) => {
    setExpandedDoc(expandedDoc === index ? null : index);
  };

  const scrollTo = (ref) => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const LOG_COLOR = { err: COLOR.coral, in: COLOR.green, out: COLOR.cream, info: COLOR.dim };
  const LOG_PREFIX = { in: "↓", out: "❯", err: "✕", info: "·" };

  return (
    <div style={{ background: COLOR.bgFlat, color: COLOR.text, fontFamily: FONT_BODY, minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        
        * { box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        html, body { background: ${COLOR.bgFlat}; margin: 0; padding: 0; }
        * { scrollbar-color: #3A3226 ${COLOR.bgFlat}; scrollbar-width: thin; }
        ::-webkit-scrollbar { width: 9px; height: 9px; }
        ::-webkit-scrollbar-track { background: ${COLOR.bgFlat}; }
        ::-webkit-scrollbar-thumb { background: #3A3226; border-radius: 5px; }
        ::-webkit-scrollbar-thumb:hover { background: #4A4030; }
        
        textarea, input, select {
          font-family: ${FONT_MONO}; font-size: 14px; background: ${COLOR.panel2}; color: ${COLOR.text};
          border: 1px solid ${COLOR.borderSoft}; border-radius: 12px; padding: 12px 14px; width: 100%; outline: none;
          transition: border-color 0.2s;
        }
        textarea:focus, input:focus, select:focus { border-color: ${COLOR.green}; }
        
        .pill { border-radius: 999px; font-family: ${FONT_DISPLAY}; font-weight: 700; cursor: pointer; transition: 0.15s; border: none; }
        .pill-green { background: ${COLOR.green}; color: #10160F; }
        .pill-green:hover { background: #A6F1BB; }
        .pill-cream { background: ${COLOR.cream}; color: #10160F; }
        .pill-cream:hover { background: #ffffff; }
        .pill-outline { background: transparent; color: ${COLOR.text}; border: 1px solid ${COLOR.border}; }
        .pill-outline:hover { border-color: ${COLOR.green}; color: ${COLOR.green}; }
        
        .bp-row { 
          display: grid; 
          grid-template-columns: 50px 220px 1fr auto; 
          gap: 24px; 
          align-items: center; 
          padding: 24px 0; 
          border-bottom: 1px solid ${COLOR.borderSoft}; 
        }
        .status-tag { font-family: ${FONT_MONO}; font-size: 13px; padding: 6px 0; border-radius: 4px; font-weight: 600; text-align: center; }
        .doc-panel { background: ${COLOR.greenSoft}; border-left: 2px solid ${COLOR.green}; padding: 16px 20px; margin: 0 0 20px 0; border-radius: 0 8px 8px 0; font-size: 14px; color: #C9C1B2; line-height: 1.6; font-family: ${FONT_BODY}; grid-column: 1 / -1; }
        
        .side-link { display: block; padding: 10px 0 10px 20px; border-left: 2px solid ${COLOR.borderSoft}; color: ${COLOR.muted}; font-size: 15px; text-decoration: none; font-family: ${FONT_BODY}; transition: 0.15s; }
        .side-link:hover { color: ${COLOR.text}; border-left-color: ${COLOR.dim}; }
        
        .hero-shape-top {
          background: ${COLOR.green};
          border-radius: 120px;
          position: absolute;
          z-index: 1;
          opacity: 0;
          animation: animTop 2.5s ease-in-out forwards;
        }
        
        .hero-shape-bottom {
          background: ${COLOR.green};
          border-radius: 120px;
          position: absolute;
          z-index: 1;
          opacity: 0;
          animation: animBottom 2.5s ease-in-out forwards;
        }
        
        .hero-terminal {
          position: relative;
          z-index: 10;
          width: 100%;
          max-width: 360px;
          height: 250px; 
          margin: 0 auto;
          opacity: 0;
          animation: animTerminal 2.5s ease-out forwards;
        }

        @keyframes animTerminal {
          0% { transform: scale(0.85); opacity: 0; }
          15%, 100% { transform: scale(1); opacity: 1; }
        }

        @keyframes animTop {
          0%, 15% { opacity: 0; top: 100px; left: 40px; width: 120px; height: 140px; }
          20% { opacity: 1; top: 100px; left: 40px; width: 120px; height: 140px; }
          35% { opacity: 1; top: -10px; left: 40px; width: 120px; height: 260px; }
          55%, 100% { opacity: 1; top: -10px; left: 10px; width: 360px; height: 260px; } 
        }

        @keyframes animBottom {
          0%, 15% { opacity: 0; top: 100px; right: 40px; width: 120px; height: 140px; }
          20% { opacity: 1; top: 100px; right: 40px; width: 120px; height: 140px; }
          35%, 55% { opacity: 1; top: 200px; right: 40px; width: 120px; height: 240px; }
          75%, 100% { opacity: 1; top: 200px; right: -10px; width: 380px; height: 240px; } 
        }

        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }

        /* --- Footer Wall of Love Styles --- */
        .wall-container {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 24px;
          max-width: 1100px;
          margin: 0 auto;
          padding: 60px 24px 40px;
        }
        
        .wall-card {
          width: calc(33.333% - 16px);
          min-width: 300px;
          position: relative;
          padding: 28px 24px 24px;
          border-radius: 12px;
          text-decoration: none;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          transition: transform 0.2s;
        }
        
        .wall-card:hover {
          transform: translateY(-4px);
        }
        
        .wall-avatar {
          position: absolute;
          top: -16px;
          left: 24px;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 10px rgba(0,0,0,0.15);
        }

        @media (min-width: 960px) {
          .wall-card:nth-child(1) { margin-top: 20px; }
          .wall-card:nth-child(2) { margin-top: 60px; }
          .wall-card:nth-child(3) { margin-top: 0px; }
          .wall-card:nth-child(4) { margin-top: -20px; }
          .wall-card:nth-child(5) { margin-top: 20px; }
        }

        .footer-action-btn {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 12px 24px;
          border-radius: 999px;
          font-family: ${FONT_DISPLAY};
          font-weight: 600;
          font-size: 14px;
          text-decoration: none;
          transition: all 0.2s;
          border: none;
          cursor: pointer;
        }
        .btn-white {
          background: ${COLOR.cream};
          color: #10160F;
        }
        .btn-white:hover {
          background: #ffffff;
        }
        .btn-dark {
          background: #2C2A28;
          color: ${COLOR.cream};
        }
        .btn-dark:hover {
          background: #3A3836;
        }

        @media (max-width: 1024px) {
          .console-layout { grid-template-columns: 1fr !important; }
          .hero-layout { grid-template-columns: 1fr !important; }
          .hero-graphic-container { display: none !important; }
        }
        @media (max-width: 760px) {
          .bp-row { grid-template-columns: 1fr; gap: 16px; padding: 16px 0; }
          .docs-grid { grid-template-columns: 1fr !important; }
          .wall-card { width: 100%; margin-top: 16px !important; }
        }
      `}</style>

      <div>
        <div style={{ maxWidth: 1400, margin: "0 auto", padding: "24px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 20, letterSpacing: "-0.02em" }}>WIRELINE.</span>
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <button className="pill pill-outline" onClick={() => scrollTo(docsRef)} style={{ padding: "10px 20px", fontSize: 14 }}>
              Documentation
            </button>
            <button className="pill pill-green" onClick={() => scrollTo(consoleRef)} style={{ padding: "10px 20px", fontSize: 14 }}>
              Open Console →
            </button>
          </div>
        </div>
      </div>

      <div className="hero-layout" style={{
        minHeight: "calc(100vh - 80px)", display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 60,
        alignItems: "center", maxWidth: 1400, margin: "0 auto", padding: "0 32px",
      }}>
        <div>
          <h1 style={{
            fontFamily: FONT_DISPLAY, fontWeight: 700, textTransform: "uppercase",
            fontSize: "clamp(48px, 8vw, 84px)", lineHeight: 0.95, letterSpacing: "-0.02em",
            margin: "0 0 28px", maxWidth: 700,
          }}>
            Talk to your<br />server directly
          </h1>
          <p style={{ color: COLOR.muted, fontSize: 18, lineHeight: 1.7, margin: "0 0 40px", maxWidth: 500, fontFamily: FONT_BODY }}>
            Real requests, real responses. No mocks, no simulation. Test caching, chunked streams, and WebSocket handshakes from the browser.
          </p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <button className="pill pill-green" onClick={() => scrollTo(consoleRef)} style={{ padding: "16px 32px", fontSize: 15 }}>Open Console</button>
            <button className="pill pill-outline" onClick={() => scrollTo(docsRef)} style={{ padding: "16px 32px", fontSize: 15 }}>Read Documentation</button>
          </div>
        </div>
        
        <div className="hero-graphic-container" style={{ position: "relative", height: "450px", display: "flex", alignItems: "center", justifyContent: "center" }}>
          
          <div className="hero-shape-top" />
          <div className="hero-shape-bottom" />

          <div className="hero-terminal">
            
            <div style={{ position: "absolute", top: -40, left: -40, width: "85%", height: "90%", background: "#2C2A28", borderRadius: 12, boxShadow: "0 10px 30px rgba(0,0,0,0.5)" }}>
               <div style={{ padding: "10px 14px", display: "flex", gap: 6 }}>
                 <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLOR.dim }} />
                 <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLOR.dim }} />
                 <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLOR.dim }} />
               </div>
               <div style={{ padding: "14px 20px", fontFamily: FONT_MONO, color: COLOR.muted, fontSize: 12, opacity: 0.7 }}>
                  <div style={{ marginBottom: 14 }}><span style={{color: COLOR.green}}>$ https</span> -v PUT wireline.dev</div>
                  <div style={{ width: "65%", height: 6, background: COLOR.dim, borderRadius: 4, marginBottom: 10 }} />
                  <div style={{ width: "80%", height: 6, background: COLOR.dim, borderRadius: 4, marginBottom: 10 }} />
                  <div style={{ width: "45%", height: 6, background: COLOR.dim, borderRadius: 4, marginBottom: 10 }} />
                  <div style={{ width: "70%", height: 6, background: COLOR.dim, borderRadius: 4, marginBottom: 10 }} />
               </div>
            </div>

            <div style={{ position: "absolute", bottom: -40, right: -40, width: "95%", height: "100%", background: COLOR.terminalBg, borderRadius: 12, border: `1px solid ${COLOR.border}`, boxShadow: "0 30px 60px rgba(0,0,0,0.7)" }}>
               <div style={{ padding: "12px 16px", borderBottom: `1px solid ${COLOR.borderSoft}`, background: "#1C1B1A", display: "flex", alignItems: "center", justifyContent: "space-between", borderTopLeftRadius: 12, borderTopRightRadius: 12 }}>
                 <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ background: COLOR.borderSoft, padding: "3px 8px", borderRadius: 6, fontSize: 10, fontFamily: FONT_DISPLAY, color: COLOR.text, fontWeight: 700 }}>PUT ↓</div>
                    <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: COLOR.muted }}>
                      <span style={{ color: COLOR.green }}>https://wireline.dev</span>/put/123
                    </div>
                 </div>
                 <div style={{ width: 18, height: 18, borderRadius: "50%", background: COLOR.green, display: "flex", alignItems: "center", justifyContent: "center" }}>
                   <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#10160F" strokeWidth="4" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
                 </div>
               </div>
               <div style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", gap: 10 }}>
                    <div style={{ width: "25%", height: 6, background: COLOR.muted, borderRadius: 4 }} />
                    <div style={{ width: "40%", height: 6, background: COLOR.dim, borderRadius: 4 }} />
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <div style={{ width: "35%", height: 6, background: COLOR.muted, borderRadius: 4 }} />
                    <div style={{ width: "20%", height: 6, background: COLOR.dim, borderRadius: 4 }} />
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <div style={{ width: "15%", height: 6, background: COLOR.muted, borderRadius: 4 }} />
                    <div style={{ width: "65%", height: 6, background: COLOR.dim, borderRadius: 4 }} />
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                    <div style={{ width: "45%", height: 6, background: COLOR.muted, borderRadius: 4 }} />
                    <div style={{ width: "35%", height: 6, background: COLOR.dim, borderRadius: 4 }} />
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <div style={{ width: "60%", height: 6, background: COLOR.muted, borderRadius: 4 }} />
                    <div style={{ width: "15%", height: 6, background: COLOR.dim, borderRadius: 4 }} />
                  </div>
               </div>
            </div>
          </div>
        </div>
      </div>

      <div ref={consoleRef} style={{ maxWidth: 1400, margin: "0 auto", padding: "80px 32px 0" }}>
        
        <div className="console-layout" style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 48 }}>
          
          <div>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 14, color: COLOR.muted, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 20 }}>
              Request Builder
            </div>
            
            <div style={{ background: COLOR.panel, border: `1px solid ${COLOR.border}`, borderRadius: 20, padding: 24, marginBottom: 48 }}>
              <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                <select value={method} onChange={e => setMethod(e.target.value)} style={{ width: 110, fontWeight: 700, color: COLOR.green, fontSize: 15 }}>
                  <option>GET</option>
                  <option>POST</option>
                  <option>PUT</option>
                  <option>DELETE</option>
                  <option>WS</option>
                </select>
                <input value={path} onChange={e => setPath(e.target.value)} placeholder="/path" style={{ fontSize: 15 }} />
                <button
                  className="pill pill-green"
                  onClick={fireRequest}
                  disabled={isRequesting}
                  style={{ padding: "0 32px", fontSize: 15, whiteSpace: "nowrap", opacity: isRequesting ? 0.6 : 1, cursor: isRequesting ? "not-allowed" : "pointer" }}
                >
                  {isRequesting ? "Sending…" : "Send"}
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                <div>
                  <label style={{ display: "block", fontSize: 12, color: COLOR.muted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1, fontFamily: FONT_DISPLAY }}>Headers (Key: Value)</label>
                  <textarea value={headersText} onChange={e => setHeadersText(e.target.value)} rows={5} placeholder="Range: bytes=0-100&#10;Authorization: Bearer token" disabled={method === "WS"} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, color: COLOR.muted, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1, fontFamily: FONT_DISPLAY }}>Body Payload</label>
                  <textarea value={bodyText} onChange={e => setBodyText(e.target.value)} rows={5} placeholder="Request body here..." disabled={method === "GET"} />
                </div>
              </div>
            </div>

            <div>
              <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 14, color: COLOR.muted, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 12 }}>
                Blueprints
              </div>
              <p style={{ color: COLOR.muted, fontSize: 15, lineHeight: 1.7, margin: "0 0 24px", fontFamily: FONT_BODY }}>
                Pre-built requests targeting specific routes. Load a template into the console, then hit <strong>Send</strong>.
              </p>

              <div style={{ borderTop: `1px solid ${COLOR.borderSoft}` }}>
                {FEATURE_TEMPLATES.map((t, i) => (
                  <div key={i} style={{ display: "contents" }}>
                    <div className="bp-row">
                      <span className="status-tag" style={{
                        background: t.code.startsWith("4") ? "rgba(255,123,114,0.08)" : COLOR.greenSoft,
                        color: t.code.startsWith("4") ? COLOR.coral : COLOR.green,
                      }}>{t.code}</span>
                      
                      <span style={{ fontFamily: FONT_MONO, fontSize: 14, color: COLOR.text }}>
                        <strong style={{ marginRight: 8 }}>{t.method}</strong> 
                        <span style={{ color: COLOR.muted }}>{t.path}</span>
                      </span>
                      
                      <div style={{ fontSize: 14, color: COLOR.muted, fontFamily: FONT_BODY, lineHeight: 1.5 }}>
                        <span style={{ color: COLOR.text, fontWeight: 600 }}>{t.title}:</span> {t.desc}
                      </div>
                      
                      <div style={{ display: "flex", gap: 12 }}>
                        <button className="pill pill-outline" onClick={() => toggleDoc(i)} style={{ fontSize: 12, padding: "8px 16px" }}>
                          {expandedDoc === i ? "Hide" : "Details"}
                        </button>
                        <button className="pill pill-outline" onClick={() => applyTemplate(t)} style={{ fontSize: 12, padding: "8px 16px" }}>
                          Auto-Fill
                        </button>
                      </div>
                    </div>
                    {expandedDoc === i && (
                      <div className="doc-panel" style={{ marginTop: -8 }}>{t.doc}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ position: "sticky", top: 40, height: "fit-content" }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 14, color: COLOR.muted, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 20 }}>
              Live Terminal
            </div>
            
            <div style={{ 
              background: "#0A0907", 
              border: `1px solid ${COLOR.border}`, 
              borderRadius: 16, 
              overflow: "hidden", 
              boxShadow: "0 10px 30px rgba(0,0,0,0.5)"
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: `1px solid ${COLOR.borderSoft}`, background: "#13110E" }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <span style={{ width: 12, height: 12, borderRadius: "50%", background: COLOR.coral }} />
                  <span style={{ width: 12, height: 12, borderRadius: "50%", background: COLOR.amber }} />
                  <span style={{ width: 12, height: 12, borderRadius: "50%", background: COLOR.green }} />
                </div>
                <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: COLOR.dim }}>
                  ~/server/response
                </span>
                <div style={{ width: 44 }}></div>
              </div>
              
              <div style={{ height: 600, overflowY: "auto", padding: "24px", fontFamily: FONT_MONO, fontSize: 14, lineHeight: 1.8 }}>
                {logs.length === 0 && (
                  <div style={{ color: COLOR.dim }}>
                    <span style={{ color: COLOR.green }}>guest@wireline</span>
                    <span>:~$ </span>
                    <span style={{ animation: "blink 1s step-end infinite" }}>▍</span>
                  </div>
                )}
                {logs.map((log, i) => (
                  <div key={i} style={{ color: LOG_COLOR[log.type], wordBreak: "break-all", marginBottom: 4 }}>
                    <span style={{ opacity: 0.55, marginRight: 12 }}>{LOG_PREFIX[log.type]}</span>
                    {log.msg}
                  </div>
                ))}
                {logs.length > 0 && !isRequesting && (
                  <div style={{ color: COLOR.dim, marginTop: 12 }}>
                    <span style={{ color: COLOR.green }}>guest@wireline</span>:~$ <span style={{ animation: "blink 1s step-end infinite" }}>▍</span>
                  </div>
                )}
                <div ref={logEndRef} />
              </div>
            </div>
            
          </div>

        </div>
      </div>

      <div ref={docsRef} style={{ maxWidth: 1400, margin: "0 auto", padding: "120px 32px 60px" }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: COLOR.dim, letterSpacing: ".06em", marginBottom: 20 }}>
          WIRELINE / DOCS
        </div>
        <h2 style={{
          fontFamily: FONT_DISPLAY, fontWeight: 700, textTransform: "uppercase",
          fontSize: "clamp(36px, 6vw, 64px)", lineHeight: 1, letterSpacing: "-0.01em", margin: "0 0 24px",
        }}>
          Server Docs
        </h2>
        <p style={{ color: COLOR.muted, fontSize: 17, lineHeight: 1.75, maxWidth: 800, margin: "0 0 64px", fontFamily: FONT_BODY }}>
          Written directly from <code style={{ background: COLOR.panel, color: COLOR.green, padding: "2px 8px", borderRadius: 6, fontFamily: FONT_MONO, fontSize: 15 }}>server.ts</code>. No Express, no Node HTTP module just <code style={{ background: COLOR.panel, color: COLOR.green, padding: "2px 8px", borderRadius: 6, fontFamily: FONT_MONO, fontSize: 15 }}>net.Socket</code>, buffers, and the HTTP/1.1 specification. Every request is parsed, validated, and responded to manually.
        </p>

        <div className="docs-grid" style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 64 }}>
          <div>
            {DOC_SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="side-link">{s.title}</a>
            ))}
          </div>

          <div>
            {DOC_SECTIONS.map((s, i) => (
              <div key={s.id} id={s.id} style={{
                padding: "32px 0", borderTop: i === 0 ? `1px solid ${COLOR.borderSoft}` : "none",
                borderBottom: `1px solid ${COLOR.borderSoft}`, scrollMarginTop: 120,
              }}>
                <h3 style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 20, margin: "0 0 16px", color: COLOR.text }}>{s.title}</h3>
                <p style={{ color: COLOR.muted, fontSize: 16, lineHeight: 1.8, margin: 0, fontFamily: FONT_BODY, maxWidth: 800 }}>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ background: "#110E0B", paddingBottom: "80px", borderTop: `1px solid ${COLOR.borderSoft}` }}>
        <div className="wall-container">
          
          {/* Card 1: GitHub Repo */}
          <a href="https://github.com/subhaushsingh/custom-http-server" target="_blank" rel="noreferrer" className="wall-card" style={{ background: "#79E381", color: "#10160F" }}>
            <div className="wall-avatar" style={{ background: "#ffffff" }}>
               <svg width="18" height="18" fill="#10160F" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            </div>
            <p style={{ margin: 0, fontSize: "14px", lineHeight: 1.6 }}>
              I built this custom HTTP server entirely from scratch using Node.js net.Socket. Check out the source code!
            </p>
            <div style={{ marginTop: "16px", fontSize: "12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              @subhaushsingh/custom-http-server
            </div>
          </a>


          <a href="https://www.linkedin.com/in/subh-aush-singh/" target="_blank" rel="noreferrer" className="wall-card" style={{ background: "#5B84F7", color: "#ffffff" }}>
            <div className="wall-avatar" style={{ background: "#FF7B72" }}>
               <svg width="16" height="16" fill="#ffffff" viewBox="0 0 24 24"><path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/></svg>
            </div>
            <p style={{ margin: 0, fontSize: "14px", lineHeight: 1.6 }}>
              Let's connect professionally! Always open to discussing backend engineering, networking, and software architecture.
            </p>
            <div style={{ marginTop: "16px", fontSize: "12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              @subh-aush-singh
            </div>
          </a>

          <a href="https://x.com/aush_subh" target="_blank" rel="noreferrer" className="wall-card" style={{ background: "#FA90F4", color: "#10160F" }}>
            <div className="wall-avatar" style={{ background: "#ffffff" }}>
              <svg width="14" height="14" fill="#10160F" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            </div>
            <p style={{ margin: 0, fontSize: "14px", lineHeight: 1.6 }}>
              Follow me for tech tweets, development updates, and random coding thoughts. DMs are always open!
            </p>
            <div style={{ marginTop: "16px", fontSize: "12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              @aush_subh
            </div>
          </a>

          <a href="https://github.com/subhaushsingh" target="_blank" rel="noreferrer" className="wall-card" style={{ background: "#FA90F4", color: "#10160F" }}>
            <div className="wall-avatar" style={{ background: "#8FEAA9" }}>
               <svg width="18" height="18" fill="#10160F" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            </div>
            <p style={{ margin: 0, fontSize: "14px", lineHeight: 1.6 }}>
              Explore my other projects, open-source contributions, and everything else I'm working on.
            </p>
            <div style={{ marginTop: "16px", fontSize: "12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              @subhaushsingh
            </div>
          </a>

          <a href="https://leetcode.com/u/SUBH_AUSH_SINGH/" target="_blank" rel="noreferrer" className="wall-card" style={{ background: "#79E381", color: "#10160F" }}>
            <div className="wall-avatar" style={{ background: "#5B84F7" }}>
               <svg width="16" height="16" fill="#ffffff" viewBox="0 0 24 24"><path d="M13.483 0a1.374 1.374 0 0 0-.961.438L7.116 6.226l-3.854 4.126a5.266 5.266 0 0 0-1.209 2.104 5.35 5.35 0 0 0-.125.513 5.527 5.527 0 0 0 .062 2.362 5.83 5.83 0 0 0 .349 1.017 5.939 5.939 0 0 0 1.271 1.543l3.995 3.737.766.714a.448.448 0 0 0 .625-.01.448.448 0 0 0 .01-.625l-.767-.714-3.994-3.737a4.914 4.914 0 0 1-1.049-1.272 4.795 4.795 0 0 1-.295-.858 4.542 4.542 0 0 1-.052-1.956 4.316 4.316 0 0 1 .1-.417 4.256 4.256 0 0 1 .98-1.705l3.854-4.126 5.406-5.788a.386.386 0 0 1 .271-.122.38.38 0 0 1 .27.122l1.583 1.696a.448.448 0 0 0 .633.003.448.448 0 0 0 .003-.633zM22.327 16.27a.448.448 0 0 0-.448.448v.987a.448.448 0 0 0 .448.448h.987a.448.448 0 0 0 .448-.448v-.987a.448.448 0 0 0-.448-.448zM12.025 17.251a.448.448 0 0 0-.448.448v.987a.448.448 0 0 0 .448.448h.987a.448.448 0 0 0 .448-.448v-.987a.448.448 0 0 0-.448-.448zM20.29 16.27a.448.448 0 0 0-.448.448v.987a.448.448 0 0 0 .448.448h.987a.448.448 0 0 0 .448-.448v-.987a.448.448 0 0 0-.448-.448z"/></svg>
            </div>
            <p style={{ margin: 0, fontSize: "14px", lineHeight: 1.6 }}>
              Check out my problem-solving journey, data structures, and algorithmic challenges.
            </p>
            <div style={{ marginTop: "16px", fontSize: "12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              @SUBH_AUSH_SINGH
            </div>
          </a>
        </div>

        <div style={{ display: "flex", justifyContent: "center", gap: "16px", flexWrap: "wrap", marginTop: "40px" }}>
          <a href="https://github.com/subhaushsingh/custom-http-server" target="_blank" rel="noreferrer" className="footer-action-btn btn-white">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg> 
            Explore Source
          </a>
          <a href="https://www.linkedin.com/in/subh-aush-singh/" target="_blank" rel="noreferrer" className="footer-action-btn btn-dark">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 24 24"><path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/></svg> 
            Connect on LinkedIn
          </a>
          <a href="https://x.com/aush_subh" target="_blank" rel="noreferrer" className="footer-action-btn btn-dark">
            <svg width="14" height="14" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg> 
            Follow @aush_subh
          </a>
        </div>
      </div>
    </div>
  );
}
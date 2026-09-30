// Backend abstraction for Boundary Lab.
// Routes API calls to either the WASM (client-side) backend or the server (fetch) backend.
// Loaded before app.js. The WASM backend is preferred when available.
(function() {
  "use strict";

  const Backend = {
    wasm: null,
    useWasm: false,
    initialized: false,

    async init() {
      if (this.initialized) return;
      this.initialized = true;
      // Try WASM first; fall back to server on any failure.
      try {
        if (typeof BezoptWasm === "undefined") {
          throw new Error("BezoptWasm not loaded");
        }
        this.wasm = new BezoptWasm();
        await this.wasm.init();
        // Verify with a defaults call.
        this.wasm.defaults();
        this.useWasm = true;
        console.log("[Backend] Using WASM (client-side) backend");
      } catch (error) {
        console.log("[Backend] WASM unavailable, using server backend:", error.message);
        this.useWasm = false;
        this.wasm = null;
      }
    },

    // Unified API call. Returns the result object or throws on error.
    // For the server backend, mirrors the fetch + parseJsonBody + ok-check pattern.
    async call(endpoint, payload) {
      if (this.useWasm && this.wasm) {
        return this._callWasm(endpoint, payload);
      }
      return this._callServer(endpoint, payload);
    },

    _callWasm(endpoint, payload) {
      const wasm = this.wasm;
      switch (endpoint) {
        case "/api/defaults":
          return wasm.defaults();
        case "/api/health":
          return { status: "ok", backend: "wasm", library: "bezopt.wasm" };
        case "/api/preprocess":
          return wasm.preprocess(payload);
        case "/api/fit":
          return wasm.fit(payload);
        case "/api/optimize":
          return wasm.optimize(payload);
        case "/api/render-reference":
          return wasm.render_reference(payload);
        case "/api/export-flat-svg":
          return wasm.export_flat_svg(payload);
        case "/api/optimize-raster":
          return wasm.optimize_raster(payload);
        default:
          throw new Error(`Unknown endpoint: ${endpoint}`);
      }
    },

    async _callServer(endpoint, payload) {
      const options = payload ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      } : {};
      const response = await fetch(endpoint, options);
      const result = await parseJsonBody(response);
      if (!response.ok) {
        throw new Error((result && result.error) || `Request failed (${response.status})`);
      }
      return result;
    },

    // For UI display: which backend is active.
    describe() {
      return this.useWasm ? "wasm" : "server";
    }
  };

  window.Backend = Backend;
})();

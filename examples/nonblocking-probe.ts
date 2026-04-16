import { Webview } from "../src";

type ProbeMode = "bindings" | "server";

type BindingResult = {
  kind: "bindings";
  sync: string;
  async: string;
  raw: string;
};

type ServerResult = {
  kind: "server";
  href: string;
};

type ProbeReport = BindingResult | ServerResult;

const mode = (Bun.argv[2] ?? "bindings") as ProbeMode;
const timeoutMs = Number(Bun.argv[3] ?? "5000");

let timeout: ReturnType<typeof setTimeout> | undefined;
let server: Bun.Server<undefined> | undefined;
let exitCode = 1;

function finish(webview: Webview, code: number, report: ProbeReport | string) {
  exitCode = code;
  if (timeout) {
    clearTimeout(timeout);
  }
  if (server) {
    server.stop(true);
  }

  console.log(
    typeof report === "string"
      ? report
      : `[probe] ${JSON.stringify(report, null, 2)}`,
  );

  webview.destroy();
}

function startTimeout(webview: Webview, label: string) {
  timeout = setTimeout(() => {
    finish(webview, 1, `[probe] timeout waiting for ${label}`);
  }, timeoutMs);
}

function runBindingsProbe() {
  const webview = new Webview();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        "<html><body><h1>bindings probe</h1><script>window.addEventListener('load', () => pageReady())</script></body></html>",
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
    },
  });

  webview.title = "nonblocking bindings probe";
  webview.bind("syncPress", () => ({ kind: "sync" }));
  webview.bind("asyncPress", async () => {
    await Bun.sleep(10);
    return { kind: "async" };
  });
  webview.bind("trace", (label: string) => {
    console.log(`[probe.bindings] ${label}`);
    return { ok: true };
  });
  webview.bind("pageReady", () => {
    setTimeout(() => {
      webview.eval(`
        (async () => {
          try {
            await trace("before-sync");
            const syncResult = await syncPress();
            await trace("after-sync");
            const asyncResult = await asyncPress();
            await trace("after-async");
            const rawResult = await rawAsync();
            await trace("after-raw");
            await report(JSON.stringify({
              kind: "bindings",
              sync: syncResult.kind,
              async: asyncResult.kind,
              raw: rawResult.kind
            }));
          } catch (error) {
            await report(JSON.stringify({
              kind: "bindings",
              sync: "error",
              async: "error",
              raw: error instanceof Error ? error.message : String(error)
            }));
          }
        })();
      `);
    }, 0);

    return { ok: true };
  });
  webview.bindRaw("rawAsync", (seq) => {
    void Bun.sleep(10).then(() => {
      webview.return(seq, 0, JSON.stringify({ kind: "raw-async" }));
    }, (error) => {
      webview.return(
        seq,
        1,
        JSON.stringify(error instanceof Error ? error.message : String(error)),
      );
    });
  });
  webview.bind("report", (payload: string) => {
    const result = JSON.parse(payload) as BindingResult;
    const ok = result.sync === "sync" &&
      result.async === "async" &&
      result.raw === "raw-async";

    setTimeout(() => finish(webview, ok ? 0 : 1, result), 0);
    return { ok };
  });

  webview.navigate(server.url.toString());
  startTimeout(webview, "binding results");
  webview.run(() => process.exit(exitCode));
}

function runServerProbe() {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        return new Response(
          `<!doctype html><html><body><script>
            reportServer(JSON.stringify({ kind: "server", href: window.location.href }));
          </script></body></html>`,
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          },
        );
      }

      return new Response("not found", { status: 404 });
    },
  });

  const webview = new Webview();
  webview.title = "nonblocking server probe";
  webview.bind("reportServer", (payload: string) => {
    const result = JSON.parse(payload) as ServerResult;
    const ok = result.href.startsWith(server?.url.toString() ?? "");

    setTimeout(() => finish(webview, ok ? 0 : 1, result), 0);
    return { ok };
  });
  webview.navigate(server.url.toString().replace("0.0.0.0", "127.0.0.1"));

  startTimeout(webview, "server navigation");
  webview.run(() => process.exit(exitCode));
}

if (mode === "server") {
  runServerProbe();
} else {
  runBindingsProbe();
}

import { CString, FFIType, JSCallback, type Pointer } from "bun:ffi";
import { encodeCString, instances, lib } from "./ffi";

const enum WebviewErrorCode {
  INVALID_ARGUMENT = -2,
  OK = 0,
  DUPLICATE = 1,
  NOT_FOUND = 2,
}

export type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Replacer = (this: unknown, key: string, value: unknown) => unknown;

function encodeResult(value: unknown, replacer?: Replacer): string {
  return JSON.stringify(value, replacer) ?? "null";
}

function encodeError(value: unknown, replacer?: Replacer): string {
  try {
    return JSON.stringify(value, replacer) ?? "null";
  } catch {
    return JSON.stringify({
      message: "Failed to JSON stringify binding error.",
      name: "Error",
    });
  }
}

function createBindError(name: string, code: number): Error {
  if (code === WebviewErrorCode.DUPLICATE) {
    return new Error(`A binding named "${name}" already exists.`);
  }

  return new Error(`Failed to bind "${name}" (webview error ${code}).`);
}

/** Window size */
export interface Size {
  /** The width of the window */
  width: number;
  /** The height of the window */
  height: number;
  /** The window size hint */
  hint: SizeHint;
}

/** Window size hints */
export const enum SizeHint {
  /** Width and height are default size */
  NONE,
  /** Width and height are minimum bounds */
  MIN,
  /** Width and height are maximum bounds */
  MAX,
  /** Window size can not be changed by a user */
  FIXED,
}

export interface WebviewOptions {
  debug?: boolean;
  handle?: Pointer;
  replacer?: Replacer;
  size?: Size;
  window?: Pointer | null;
}

export interface WebviewApi {
  setReviver(fn: (this: unknown, key: string, value: unknown) => unknown): void;
}

function createWebviewErrorMessage() {
  if (process.platform === "win32") {
    return "Failed to create the native webview instance. WebView2 may be missing or unavailable on this system.";
  }

  return "Failed to create the native webview instance.";
}

/** An instance of a webview window.*/
export class Webview {
  #handle: Pointer | null = null;
  #callbacks: Map<string, JSCallback> = new Map();
  #replacer?: Replacer;

  /** **UNSAFE**: Highly unsafe API, beware!
   *
   * An unsafe pointer to the webview
   */
  get unsafeHandle() {
    return this.#handle;
  }

  /** **UNSAFE**: Highly unsafe API, beware!
   *
   * An unsafe pointer to the webviews platform specific native window handle.
   * When using GTK backend the pointer is `GtkWindow` pointer, when using Cocoa
   * backend the pointer is `NSWindow` pointer, when using Win32 backend the
   * pointer is `HWND` pointer.
   */
  get unsafeWindowHandle() {
    return lib.symbols.webview_get_window(this.#handle);
  }

  /**
   * Sets the native window size
   *
   * ## Example
   *
   * ```ts
   * import { Webview, SizeHint } from "webview-bun";
   *
   * const webview = new Webview();
   * webview.navigate("https://bun.sh/");
   *
   * // Change from the default size to a small fixed window
   * webview.size = {
   *   width: 200,
   *   height: 200,
   *   hint: SizeHint.FIXED
   * };
   *
   * webview.run();
   * ```
   */
  set size({ width, height, hint }: Size) {
    //@ts-ignore
    lib.symbols.webview_set_size(this.#handle, width, height, hint);
  }

  /**
   * Sets the native window title
   *
   * ## Example
   *
   * ```ts
   * import { Webview } from "webview-bun";
   *
   * const webview = new Webview();
   * webview.navigate("https://bun.sh/");
   *
   * // Set the window title to "Hello world!"
   * webview.title = "Hello world!";
   *
   * webview.run();
   * ```
   */
  set title(title: string) {
    lib.symbols.webview_set_title(this.#handle, encodeCString(title));
  }

  /** **UNSAFE**: Highly unsafe API, beware!
   *
   * Creates a new webview instance.
   *
   * ## Example
   *
   * ```ts
   * import { Webview, SizeHint } from "webview-bun";
   *
   * const webview = new Webview({
   *   debug: true,
   *   size: {
   *     width: 200,
   *     height: 200,
   *     hint: SizeHint.FIXED,
   *   },
   * });
   *
   * webview.navigate("https://bun.sh/");
   * webview.run();
   * ```
   *
   * @param options.debug Defaults to false, when true developer tools are
   * enabled for supported platforms.
   * @param options.handle **UNSAFE**: Highly unsafe API, beware! Wraps an
   * existing native webview handle instead of creating a new instance.
   * @param options.replacer Optional JSON replacer for bind return values and
   * bind-thrown errors.
   * @param options.size The window size, default to 1024x768 with no size
   * hint. Pass `size: undefined` to skip auto-resizing.
   * @param options.window **UNSAFE**: Highly unsafe API, beware! An unsafe
   * pointer to the platform-specific native parent window handle. If null or
   * undefined a new top-level window is created. Depending on the platform, a
   * `GtkWindow`, `NSWindow` or `HWND` pointer can be passed here.
   */
  constructor(options: WebviewOptions = {}) {
    const { debug = false, handle, window = null, size } = options;

    this.#handle = handle ?? lib.symbols.webview_create(Number(debug), window);
    this.#replacer = options.replacer;

    if (!this.#handle) {
      throw new Error(createWebviewErrorMessage());
    }

    if (!Object.hasOwn(options, "size")) {
      this.size = { width: 1024, height: 768, hint: SizeHint.NONE };
    } else if (size) {
      this.size = size;
    }

    instances.push(this);
  }

  /**
   * Destroys the webview and closes the window along with freeing all internal
   * resources.
   */
  destroy() {
    if (this.#handle === null) {
      return;
    }

    for (const callback of this.#callbacks.keys()) this.unbind(callback);
    lib.symbols.webview_terminate(this.#handle);
    lib.symbols.webview_destroy(this.#handle);
    this.#handle = null;
  }

  /**
   * Navigates webview to the given URL. URL may be a data URI, i.e.
   * `"data:text/html,<html>...</html>"`. It is often ok not to url-encodeCString it
   * properly, webview will re-encodeCString it for you.
   */
  navigate(url: string) {
    lib.symbols.webview_navigate(this.#handle, encodeCString(url));
  }

  /**
   * Sets the current HTML of the webview to the given html string.
   */
  setHTML(html: string) {
    lib.symbols.webview_set_html(this.#handle, encodeCString(html));
  }

  /**
   * Runs the webview without blocking Bun's event loop.
   *
   * @param onClose Optional callback invoked after the window closes.
   */
  run(onClose?: () => void) {
    const step = () => {
      if (this.pump(false)) {
        setTimeout(step, 0);
        return;
      }

      this.destroy();
      onClose?.();
    };

    step();
  }

  /**
   * Runs the main event loop until it's terminated. After this function exits
   * the webview is automatically destroyed.
   */
  runSync() {
    lib.symbols.webview_run(this.#handle);
    this.destroy();
  }

  /**
   * Pumps the OS message loop once.
   *
   * @param block When true, waits for at least one message before returning.
   * Defaults to false.
   * @returns `true` while the webview should keep running, otherwise `false`.
   */
  pump(block: boolean = false): boolean {
    if (this.#handle === null) {
      return false;
    }

    return !!lib.symbols.webview_pump_msgloop(this.#handle, block ? 1 : 0);
  }

  /**
   * Binds a callback so that it will appear in the webview with the given name
   * as a global async JavaScript function. Callback receives a seq and req value.
   * The seq parameter is an identifier for using {@link Webview.return} to
   * return a value while the req parameter is a string of an JSON array representing
   * the arguments passed from the JavaScript function call.
   *
   * @param name The name of the bound function
   * @param callback A callback which takes two strings as parameters: `seq`
   * and `req` and the passed {@link arg} pointer
   * @param arg A pointer which is going to be passed to the callback once called
   */
  bindRaw(
    name: string,
    callback: (seq: string, req: string, arg: Pointer | null) => void,
    arg: Pointer | null = null,
  ) {
    if (this.#callbacks.has(name)) {
      throw createBindError(name, WebviewErrorCode.DUPLICATE);
    }

    const callbackResource = new JSCallback(
      (seqPtr: Pointer, reqPtr: Pointer, arg: Pointer | null) => {
        const seq = seqPtr ? new CString(seqPtr) : "";
        const req = reqPtr ? new CString(reqPtr) : "";
        //@ts-ignore
        callback(seq, req, arg);
      },
      {
        args: [FFIType.pointer, FFIType.pointer, FFIType.pointer],
        returns: FFIType.void,
      },
    );
    const code = lib.symbols.webview_bind(
      this.#handle,
      encodeCString(name),
      callbackResource.ptr,
      arg,
    );

    if (code !== WebviewErrorCode.OK) {
      callbackResource.close();
      throw createBindError(name, code);
    }

    this.#callbacks.set(name, callbackResource);
  }

  /**
   * Binds a callback so that it will appear in the webview with the given name
   * as a global async JavaScript function. Callback arguments are automatically
   * converted from json to as closely as possible match the arguments in the
   * webview context and the callback automatically converts and returns the
   * return value to the webview.
   *
   * @param name The name of the bound function
   * @param callback A callback which is passed the arguments as called from the
   * webview JavaScript environment and optionally returns a value to the
   * webview JavaScript caller
   *
   * ## Example
   * ```ts
   * import { Webview } from "webview-bun";
   *
   * const html = `
   *   <html>
   *   <body>
   *     <h1>Hello from bun v${Bun.version}</h1>
   *     <button onclick="press('I was pressed!', 123, new Date()).then(log);">
   *       Press me!
   *     </button>
   *   </body>
   *   </html>
   * `;
   *
   * const webview = new Webview();
   *
   * webview.navigate(`data:text/html,${encodeURIComponent(html)}`);
   *
   * let counter = 0;
   * // Create and bind `press` to the webview javascript instance.
   * // This functions in addition to logging its parameters also returns
   * // a value from bun to webview.
   * webview.bind("press", (a, b, c) => {
   *   console.log(a, b, c);
   *
   *   return { times: counter++ };
   * });
   *
   * // Bind the `log` function in the webview to the parent instances `console.log`
   * webview.bind("log", (...args) => console.log(...args));
   *
   * webview.run();
   * ```
   */
  bind(name: string, callback: (...args: any) => any) {
    this.bindRaw(name, (seq, req) => {
      try {
        const args = JSON.parse(req);
        const result = callback(...args);

        if (result instanceof Promise) {
          result
            .then(
              (value) => this.return(seq, 0, encodeResult(value, this.#replacer))
            )
            .catch(
              (err) => this.return(seq, 1, encodeError(err, this.#replacer))
            );
        } else {
          this.return(seq, 0, encodeResult(result, this.#replacer));
        }
      } catch (err) {
        this.return(seq, 1, encodeError(err, this.#replacer));
      }
    });
  }

  /**
   * Unbinds a previously bound function freeing its resource and removing it
   * from the webview JavaScript context.
   *
   * @param name The name of the bound function
   */
  unbind(name: string): boolean {
    const callbackResource = this.#callbacks.get(name);
    if (!callbackResource) {
      return true;
    }

    //@ts-ignore
    const code = lib.symbols.webview_unbind(this.#handle, encodeCString(name));
    if (code !== WebviewErrorCode.OK && code !== WebviewErrorCode.NOT_FOUND) {
      return false;
    }

    callbackResource.close();
    this.#callbacks.delete(name);
    return true;
  }

  /**
   * Returns a value to the webview JavaScript environment.
   *
   * @param seq The request pointer as provided by the {@link Webview.bindRaw}
   * callback
   * @param status If status is zero the result is expected to be a valid JSON
   * result value otherwise the result is an error JSON object
   * @param result The stringified JSON response
   */
  return(seq: string, status: number, result: string): boolean {
    if (this.#handle === null) {
      return false;
    }

    const code = lib.symbols.webview_return(
      this.#handle,
      encodeCString(seq),
      status,
      encodeCString(result),
    );

    return code === WebviewErrorCode.OK;
  }

  /**
   * Evaluates arbitrary JavaScript code. Evaluation happens asynchronously,
   * also the result of the expression is ignored. Use
   * {@link Webview.bind bindings} if you want to receive notifications about
   * the results of the evaluation.
   */
  eval(source: string) {
    lib.symbols.webview_eval(this.#handle, encodeCString(source));
  }

  /**
   * Injects JavaScript code at the initialization of the new page. Every time
   * the webview will open a the new page - this initialization code will be
   * executed. It is guaranteed that code is executed before window.onload.
   */
  init(source: string) {
    lib.symbols.webview_init(this.#handle, encodeCString(source));
  }
}

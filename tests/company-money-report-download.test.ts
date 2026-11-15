import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import common from "../messages/en/common.json";

let PdfDownloadButton: typeof import("../src/components/pdf-download-button").PdfDownloadButton;
const errors: string[] = [];
const signals: string[] = [];
const links: { download: string; href: string; clicked: boolean }[] = [];
const cleanups: (() => void)[] = [];
const originals = {
  fetch: globalThis.fetch,
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  createObjectURL: URL.createObjectURL,
  revokeObjectURL: URL.revokeObjectURL,
};
let resolveFinished: () => void;
let finished: Promise<void>;

before(async () => {
  const element = (type: unknown, props: unknown) => ({ type, props });
  mock.module("react/jsx-runtime", {
    namedExports: { jsx: element, jsxs: element },
  });
  mock.module("react", {
    namedExports: {
      useState: (initial: unknown) => [
        initial,
        (value: unknown) => {
          if (typeof value === "string" && value) errors.push(value);
          if (value === false) resolveFinished();
        },
      ],
      useRef: (current: unknown) => ({ current }),
      useEffect: (effect: () => () => void) => cleanups.push(effect()),
      useCallback: (callback: unknown) => callback,
    },
  });
  mock.module("next-intl", {
    namedExports: {
      useLocale: () => "en",
      useTranslations: () => (key: keyof typeof common) => common[key],
    },
  });
  mock.module("lucide-react", { namedExports: { Download: () => null } });
  mock.module("../src/components/ui.tsx", {
    namedExports: { ErrorNotice: () => null },
  });
  ({ PdfDownloadButton } =
    await import("../src/components/pdf-download-button"));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => signals.push(event.type),
      setTimeout: (callback: () => void) => callback(),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { appendChild() {} },
      createElement: () => {
        const link = {
          download: "",
          href: "",
          clicked: false,
          click() {
            this.clicked = true;
          },
          remove() {},
        };
        links.push(link);
        return link;
      },
    },
  });
  URL.createObjectURL = () => "blob:company-money-report";
  URL.revokeObjectURL = () => {};
});

beforeEach(() => {
  errors.length = 0;
  signals.length = 0;
  links.length = 0;
  finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
});

after(() => {
  for (const cleanup of cleanups) cleanup();
  globalThis.fetch = originals.fetch;
  for (const name of ["document", "window"] as const) {
    const descriptor = originals[name];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  URL.createObjectURL = originals.createObjectURL;
  URL.revokeObjectURL = originals.revokeObjectURL;
  mock.restoreAll();
});

function clickDownload() {
  const view = PdfDownloadButton({
    href: "/api/admin/company-money/report",
    filename: "fallback.pdf",
  });
  view.props.children[0].props.onClick();
}

test("oversized reports show localized narrowing guidance", async () => {
  globalThis.fetch = async () =>
    Response.json(
      {
        success: false,
        error: { code: "REPORT_TOO_LARGE", message: "private server detail" },
      },
      { status: 400 },
    );
  clickDownload();
  await finished;
  assert.deepEqual(errors, [common.errors.REPORT_TOO_LARGE]);
  assert.equal(links.length, 0);
});

test("unknown error payloads and unexpected MIME types use safe PDF fallback", async () => {
  for (const response of [
    Response.json(
      { error: { code: "UNKNOWN", message: "private server detail" } },
      { status: 500 },
    ),
    new Response("not a PDF", { headers: { "Content-Type": "text/html" } }),
  ]) {
    errors.length = 0;
    finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    globalThis.fetch = async () => response;
    clickDownload();
    await finished;
    assert.deepEqual(errors, [common.pdfFailed]);
  }
});

test("expired sessions retain the shared access-failure signal", async () => {
  globalThis.fetch = async () =>
    Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });
  clickDownload();
  await finished;
  assert.deepEqual(signals, ["attendance:session-expired"]);
  assert.equal(links.length, 0);
});

test("successful PDF download uses the server attachment filename", async () => {
  globalThis.fetch = async (href, options) => {
    assert.equal(href, "/api/admin/company-money/report");
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.credentials, "same-origin");
    return new Response("%PDF-test", {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition":
          'attachment; filename="company-money-all-dates.pdf"',
      },
    });
  };
  clickDownload();
  await finished;
  assert.deepEqual(errors, []);
  assert.equal(links[0].download, "company-money-all-dates.pdf");
  assert.equal(links[0].clicked, true);
});

// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useExpenseFeedback,
  type ExpenseMessage,
} from "@/components/expense-feedback";
import type { Locale } from "@/i18n/config";
import { loadMessages } from "@/i18n/messages";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Feedback({
  feedback,
}: {
  feedback: ExpenseMessage | { error: unknown };
}) {
  const [message, setMessage] = useExpenseFeedback();
  return h(
    "div",
    {},
    h("p", {}, message),
    h("button", { onClick: () => setMessage(feedback) }, "Set feedback"),
  );
}

const cases: Array<{
  feedback: ExpenseMessage | { error: unknown };
  english: string;
  chinese: string;
}> = [
  {
    feedback: {
      key: "savedSuccess",
      values: { type: "EXPENSE", operation: "UPDATE", replayed: "yes" },
    },
    english: "Expense updated (the earlier submission was already recorded).",
    chinese: "支出已更新（先前的提交已记录）。",
  },
  {
    feedback: {
      key: "deletedSuccess",
      values: { type: "BALANCE_ADDED", replayed: "yes" },
    },
    english: "Balance addition deleted (the record was already deleted).",
    chinese: "余额增加记录已删除（此记录此前已删除）。",
  },
  {
    feedback: { key: "drivePaymentSaved", values: { status: "PAID" } },
    english: "Drive cost marked as paid.",
    chinese: "行车费用已标记为已支付。",
  },
  {
    feedback: { key: "driveBalanceAdded" },
    english: "Drive cost balance added successfully.",
    chinese: "行车费用余额已增加。",
  },
  {
    feedback: { key: "categoryCreated" },
    english: "Category created.",
    chinese: "类别已创建。",
  },
  {
    feedback: { key: "categoryArchived" },
    english: "Category archived. Its transaction history is preserved.",
    chinese: "类别已归档，相关交易记录已保留。",
  },
  {
    feedback: { key: "positiveBalanceAmount" },
    english: "Enter an amount greater than zero",
    chinese: "请输入大于零",
  },
  {
    feedback: {
      error: new Error("The start date must be on or before the end date."),
    },
    english: "The start date must be on or before the end date.",
    chinese: "开始日期不能晚于结束日期。",
  },
  {
    feedback: {
      error: { code: "FORBIDDEN", message: "Private server diagnostic" },
    },
    english: "You do not have access to this resource.",
    chinese: "您无权访问此资源。",
  },
];

it.each(cases)(
  "keeps feedback translatable after display: $english",
  async ({ feedback, english, chinese }) => {
    async function render(locale: Locale) {
      const messages = await loadMessages(locale);
      await act(async () =>
        root.render(
          h(NextIntlClientProvider, {
            locale,
            timeZone: "Asia/Dhaka",
            messages,
            children: h(Feedback, { feedback }),
          }),
        ),
      );
    }
    await render("en");
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("p")!.textContent).toContain(english);
    await render("zh-CN");
    expect(container.querySelector("p")!.textContent).toContain(chinese);
    expect(container.textContent).not.toContain("Private server diagnostic");
    await render("en");
    expect(container.querySelector("p")!.textContent).toContain(english);
  },
);

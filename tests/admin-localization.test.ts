// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import {
  NextIntlClientProvider,
  createTranslator,
  useTranslations,
} from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { FormField } from "@/components/resource-workspace";
import {
  getResourceConfigs,
  adminOptionLabel,
  auditValueLabel,
} from "@/components/resource-config";
import english from "../messages/en/admin.json";
import chinese from "../messages/zh-CN/admin.json";

const dictionaries = { en: english, "zh-CN": chinese };
function translator(locale: keyof typeof dictionaries) {
  return createTranslator({
    locale,
    namespace: "admin",
    messages: { admin: dictionaries[locale] },
  });
}

describe("admin localization", () => {
  it("changes resource labels while preserving fields, enum values and timezone defaults", () => {
    const en = getResourceConfigs(translator("en"));
    const zh = getResourceConfigs(translator("zh-CN"));
    expect(en.employees.title).toBe("Employees");
    expect(zh.employees.title).toBe("员工");
    for (const resource of Object.keys(en)) {
      expect(
        zh[resource].fields.map(
          ({ name, options, source, type, default: defaultValue }) => ({
            name,
            options,
            source,
            type,
            defaultValue,
          }),
        ),
      ).toEqual(
        en[resource].fields.map(
          ({ name, options, source, type, default: defaultValue }) => ({
            name,
            options,
            source,
            type,
            defaultValue,
          }),
        ),
      );
      expect(
        zh[resource].columns.map(({ key, format }) => ({ key, format })),
      ).toEqual(
        en[resource].columns.map(({ key, format }) => ({ key, format })),
      );
    }
    expect(
      zh.offices.fields.find((field) => field.name === "timezone")?.default,
    ).toBe("UTC");
    expect(adminOptionLabel(translator("zh-CN"), "MANAGE_DRIVER")).toBe(
      "司机管理员",
    );
  });

  it("localizes audit codes without translating unknown values or stored text", () => {
    const t = translator("zh-CN");
    expect(auditValueLabel(t, "CHECK_IN_SUCCESS")).toBe("签到成功");
    expect(auditValueLabel(t, "constructor")).toBe("constructor");
    expect(auditValueLabel(t, "Untranslated user note")).toBe(
      "Untranslated user note",
    );
    const configs = getResourceConfigs(t);
    expect(
      configs.audit.columns
        .find((column) => column.key === "action")
        ?.render?.("DEVICE_REVOKED", {}),
    ).toBe("设备已撤销");
    expect(
      configs.leaves.columns.find((column) => column.key === "reason")?.render,
    ).toBeUndefined();
  });

  it("switches open form labels without losing typed text, selections or checked weekdays", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    function Form() {
      const t = useTranslations("admin");
      const configs = getResourceConfigs(t);
      const fields = [
        configs.offices.fields.find((field) => field.name === "name")!,
        configs.offices.fields.find((field) => field.name === "weekendDays")!,
        configs.employees.fields.find((field) => field.name === "role")!,
      ];
      return h(
        "form",
        null,
        fields.map((field) =>
          h(FormField, { key: field.name, field, row: {} }),
        ),
      );
    }
    async function render(locale: keyof typeof dictionaries) {
      await act(async () =>
        root.render(
          h(NextIntlClientProvider, {
            locale,
            messages: { admin: dictionaries[locale] },
            children: h(Form),
          }),
        ),
      );
    }
    try {
      await render("en");
      const name =
        container.querySelector<HTMLInputElement>('input[name="name"]')!;
      name.value = "Unsaved user content 未保存";
      const role = container.querySelector<HTMLSelectElement>(
        'select[name="role"]',
      )!;
      role.value = "MANAGE_DRIVER";
      const sunday = container.querySelector<HTMLInputElement>(
        'input[name="weekendDays"][value="0"]',
      )!;
      sunday.checked = false;
      await render("zh-CN");
      expect(container.textContent).toContain("名称");
      expect(container.textContent).toContain("周日");
      expect(container.textContent).toContain("司机管理员");
      expect(container.querySelector('input[name="name"]')).toBe(name);
      const data = new FormData(container.querySelector("form")!);
      expect(data.get("name")).toBe("Unsaved user content 未保存");
      expect(data.get("role")).toBe("MANAGE_DRIVER");
      expect(data.getAll("weekendDays")).toEqual(["6"]);
      await render("en");
      expect(container.textContent).toContain("Name");
      expect(name.value).toBe("Unsaved user content 未保存");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

import { type ReactNode } from "react";
import {
  createRoot as createReactRoot,
  type Root,
  type RootOptions,
  type Container,
} from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import common from "../messages/en/common.json";
import auth from "../messages/en/auth.json";
import navigation from "../messages/en/navigation.json";
import admin from "../messages/en/admin.json";
import employee from "../messages/en/employee.json";
import expenses from "../messages/en/expenses.json";
export type { Root } from "react-dom/client";
export const testMessages = {
  common,
  auth,
  navigation,
  admin,
  employee,
  expenses,
};
export function createRoot(container: Container, options?: RootOptions): Root {
  const root = createReactRoot(container, options);
  return {
    ...root,
    render(children: ReactNode) {
      root.render(
        <NextIntlClientProvider
          locale="en"
          timeZone="Asia/Dhaka"
          messages={testMessages}
        >
          {children}
        </NextIntlClientProvider>,
      );
    },
    unmount() {
      root.unmount();
    },
  };
}

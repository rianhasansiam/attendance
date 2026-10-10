import { getMessages } from "next-intl/server";
import type { ReactNode } from "react";
import { FeatureProvider } from "./feature-provider";
export async function FeatureMessages({
  namespaces,
  children,
}: {
  namespaces: Array<"admin" | "employee" | "expenses" | "salary">;
  children: ReactNode;
}) {
  const messages = await getMessages();
  return (
    <FeatureProvider
      messages={Object.fromEntries(
        namespaces.map((namespace) => [namespace, messages[namespace]]),
      )}
    >
      {children}
    </FeatureProvider>
  );
}

import { FeatureMessages } from "@/i18n/feature-messages";
import { Suspense } from "react";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { DomainError } from "@/lib/errors";
import {
  authorizeDailyExpenses,
  canWriteDailyExpenses,
  canEditDailyExpenseTransactions,
  canDeleteDailyExpenseTransactions,
  canDownloadDailyExpenseReport,
} from "@/modules/daily-expenses/permissions";
import { StoreProvider } from "@/store/provider";
import { AppShell } from "@/components/app-shell";
import WorkspaceLoading from "@/components/workspace-loading";
import { DailyExpensesWorkspace } from "@/components/daily-expenses-workspace";

export default function DailyExpensesPage() {
  // Keep the segment's loading boundary visible before the shared client
  // session gate resolves. Private workspace content still requires server auth.
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <AuthorizedWorkspace />
    </Suspense>
  );
}

async function AuthorizedWorkspace() {
  await connection();
  const user = await requireWorkspaceUser();
  return (
    <FeatureMessages namespaces={["expenses"]}>
      <StoreProvider
        identity={{ id: user.id, role: user.role, sessionId: user.sessionId }}
      >
        <AppShell
          mode="admin"
          user={{
            id: user.id,
            profileSlug: user.profileSlug,
            name: user.name,
            email: user.email,
            role: user.role,
            image: user.image,
            hasEmployeeProfile: Boolean(user.employee),
          }}
        >
          <DailyExpensesWorkspace
            canWrite={canWriteDailyExpenses(user.role)}
            canEditTransactions={canEditDailyExpenseTransactions(user.role)}
            canDeleteTransactions={canDeleteDailyExpenseTransactions(user.role)}
            canDownloadReport={canDownloadDailyExpenseReport(user.role)}
          />
        </AppShell>
      </StoreProvider>
    </FeatureMessages>
  );
}

async function requireWorkspaceUser() {
  try {
    const user = await requireUser();
    authorizeDailyExpenses(user);
    return user;
  } catch (error) {
    if (error instanceof DomainError)
      redirect(error.status === 401 ? "/login" : "/forbidden");
    throw error;
  }
}

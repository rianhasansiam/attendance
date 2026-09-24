"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Provider } from "react-redux";
import { SessionProvider, getSession, useSession } from "next-auth/react";
import type { Session } from "next-auth";
import { useRouter } from "next/navigation";
import { Loading } from "@/components/ui";
import { makeStore, clearWorkspaceData, type AppStore } from "./make-store";
import { listenToBrowser } from "./freshness";
import { useAppSelector } from "./hooks";
import { workspaceClosed } from "./features/workspace-ui/slice";
import {
  ACCOUNT_FORBIDDEN,
  SESSION_CHECK,
  SESSION_EXPIRED,
} from "@/lib/client/session-events";

export type WorkspaceIdentity = {
  id: string;
  role: Session["user"]["role"];
  sessionId: string;
  expires?: string;
};

export function StoreProvider({
  identity,
  children,
}: {
  identity: WorkspaceIdentity;
  children: ReactNode;
}) {
  return (
    <SessionProvider
      session={
        identity.expires
          ? {
              user: { id: identity.id, role: identity.role },
              sessionId: identity.sessionId,
              expires: identity.expires,
            }
          : undefined
      }
      refetchOnWindowFocus
      refetchWhenOffline={false}
    >
      <IdentityBoundary identity={identity}>{children}</IdentityBoundary>
    </SessionProvider>
  );
}

function IdentityBoundary({
  identity,
  children,
}: {
  identity: WorkspaceIdentity;
  children: ReactNode;
}) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const matches =
    session?.user?.id === identity.id &&
    session?.user?.role === identity.role &&
    session?.sessionId === identity.sessionId;
  useEffect(() => {
    void getSession();
  }, []);
  useEffect(() => {
    if (status === "loading" || matches) return;
    // Replace the document on identity change, including server-rendered private
    // profile data and any hidden Activity trees, instead of reusing their state.
    window.location.replace(session?.user?.id ? "/" : "/login");
  }, [status, matches, session?.user?.id]);
  useEffect(() => {
    const check = () => {
      void getSession();
      router.refresh();
    };
    // getSession uses the installed Auth.js BroadcastChannel mechanism. It sends
    // an event only; each tab re-reads its own session from the server.
    window.addEventListener(SESSION_CHECK, check);
    window.addEventListener("online", check);
    return () => {
      window.removeEventListener(SESSION_CHECK, check);
      window.removeEventListener("online", check);
    };
  }, [router]);
  if (status === "loading" || !matches) return <Loading />;
  return (
    <ScopedStore key={`${identity.id}:${identity.role}:${identity.sessionId}`}>
      {children}
    </ScopedStore>
  );
}

function ScopedStore({ children }: { children: ReactNode }) {
  const [store] = useState<AppStore>(makeStore);
  useEffect(() => {
    const stopListening = listenToBrowser(store.dispatch);
    const expired = () => store.dispatch(workspaceClosed("expired"));
    const forbidden = () => store.dispatch(workspaceClosed("forbidden"));
    window.addEventListener(SESSION_EXPIRED, expired);
    window.addEventListener(ACCOUNT_FORBIDDEN, forbidden);
    return () => {
      stopListening();
      window.removeEventListener(SESSION_EXPIRED, expired);
      window.removeEventListener(ACCOUNT_FORBIDDEN, forbidden);
      clearWorkspaceData(store);
    };
  }, [store]);
  return (
    <Provider store={store}>
      <WorkspaceGate store={store}>{children}</WorkspaceGate>
    </Provider>
  );
}

function WorkspaceGate({
  store,
  children,
}: {
  store: AppStore;
  children: ReactNode;
}) {
  const status = useAppSelector((state) => state.workspaceUi.status);
  useEffect(() => {
    if (status === "active") return;
    clearWorkspaceData(store);
    if (status !== "signed-out")
      window.location.replace(status === "forbidden" ? "/forbidden" : "/login");
  }, [status, store]);
  return status === "active" ? children : <Loading />;
}

"use client";
import { AlertCircle } from "lucide-react";
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="login-page">
      <section className="login-card">
        <span className="login-mark">
          <AlertCircle size={36} />
        </span>
        <h1>Something went wrong</h1>
        <p className="muted" style={{ marginBottom: 25 }}>
          We couldn’t load this page. Please try again in a moment.
        </p>
        <button className="button" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}

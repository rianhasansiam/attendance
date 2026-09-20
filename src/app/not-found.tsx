import Link from "next/link";
export default function NotFound() {
  return (
    <main className="login-page">
      <section className="login-card">
        <p className="eyebrow">404 · PAGE NOT FOUND</p>
        <h1>A little off the path.</h1>
        <p className="muted" style={{ marginBottom: 25 }}>
          This page isn’t part of your workspace.
        </p>
        <Link href="/" className="button">
          Back to your workspace
        </Link>
      </section>
    </main>
  );
}

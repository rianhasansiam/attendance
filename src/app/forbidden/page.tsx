import Link from "next/link";
import { ShieldCheck } from "lucide-react";
export default function Forbidden() {
  return (
    <main className="login-page">
      <section className="login-card">
        <span className="login-mark">
          <ShieldCheck size={38} />
        </span>
        <h1>Access restricted</h1>
        <p className="muted" style={{ marginBottom: 25 }}>
          Your account does not have access to this workspace. Contact your
          administrator if you need access.
        </p>
        <Link href="/" className="button">
          Return to your workspace
        </Link>
      </section>
    </main>
  );
}

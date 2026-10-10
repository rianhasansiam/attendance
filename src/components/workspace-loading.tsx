import Image from "next/image";
import { LoadingIndicator } from "@/components/loading-indicator";

/** Shared visual fallback; authorization remains in the suspended route. */
export default function WorkspaceLoading() {
  return (
    <div className="workspace-loading">
      <Image
        src="/company_logo.jpeg"
        alt="XHYD"
        width={1082}
        height={205}
        sizes="148px"
        className="workspace-loading-logo"
      />
      <LoadingIndicator />
    </div>
  );
}

import Image from "next/image";
import LoadingWorkspace from "@/app/loading";

/** Visual loading state only; the existing admin authorization still gates content. */
export default function AdminLoading() {
  return (
    <div className="admin-loading">
      <Image
        src="/company_logo.jpeg"
        alt="XHYD"
        width={1082}
        height={205}
        sizes="148px"
        className="admin-loading-logo"
      />
      <LoadingWorkspace />
    </div>
  );
}

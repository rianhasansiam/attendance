import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import LoadingWorkspace from "@/app/loading";
import { PublicProfileEditor } from "@/components/public-profile-editor";
import { requirePageUser } from "@/lib/auth";
import { DomainError } from "@/lib/errors";
import { getManagedPublicProfile } from "@/modules/public-profile/management";

type Props = { params: Promise<{ userId: string }> };

async function ProfileEditorPage({ params }: Props) {
  await connection();
  const actor = await requirePageUser("SUPER_ADMIN");
  const { userId } = await params;
  let profile;
  try {
    profile = await getManagedPublicProfile(actor, userId);
  } catch (error) {
    if (error instanceof DomainError && error.status === 404) notFound();
    throw error;
  }
  return <PublicProfileEditor key={profile.id} profile={profile} />;
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <ProfileEditorPage {...props} />
    </Suspense>
  );
}

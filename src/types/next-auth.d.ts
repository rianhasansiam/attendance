import type { DefaultSession } from "next-auth";
import type { Role } from "@prisma/client";
declare module "next-auth" {
  interface Session {
    sessionId?: string;
    user: { id: string; role: Role } & DefaultSession["user"];
  }
}
declare module "next-auth/jwt" {
  interface JWT {
    sessionId?: string;
  }
}

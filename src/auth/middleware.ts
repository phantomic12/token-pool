import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import jwt from "@fastify/jwt";
import type { UserService } from "@/auth/user-service";
import type { AuthUser } from "@/types";

export interface JwtPayload {
  sub: number; // user id
  username: string;
  role: "admin" | "regular";
}

export function registerAuth(app: FastifyInstance, secret: string) {
  app.register(jwt, { secret });
}

// Decorate request with auth context
declare module "fastify" {
  interface FastifyInstance {
    authVerify: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function setupAuthGuards(app: FastifyInstance, users: UserService) {
  // Require valid JWT
  app.decorate("authVerify", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const token = extractToken(request);
      if (!token) {
        return reply.code(401).send({ error: { message: "Missing or invalid Authorization header", type: "auth_error", code: null } });
      }
      const payload = app.jwt.verify(token) as JwtPayload;
      (request as any).user = payload;
    } catch {
      return reply.code(401).send({ error: { message: "Invalid or expired token", type: "auth_error", code: null } });
    }
  });

  // Require admin role (must be called after authVerify)
  app.decorate("authAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user as JwtPayload | undefined;
    if (!user || user.role !== "admin") {
      return reply.code(403).send({ error: { message: "Admin access required", type: "auth_error", code: null } });
    }
  });
}

function extractToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(" ");
  if (parts.length === 2 && parts[0] === "Bearer") return parts[1];
  return null;
}

export function signToken(app: FastifyInstance, user: AuthUser): string {
  const payload: JwtPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
  };
  return app.jwt.sign(payload);
}

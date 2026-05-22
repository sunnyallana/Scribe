import { fileIdSchema, projectIdSchema, type UserId } from '@scribe/shared';

import { createTokenVerifier } from '../plugins/verifyToken.js';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

interface JwtPayload {
  readonly sub?: string;
  readonly email?: string;
}

async function isProjectMember(
  request: FastifyRequest,
  projectId: string,
  userId: UserId,
): Promise<boolean> {
  const { data, error } = await request.server.supabaseAdmin.rpc('is_project_member', {
    p_project_id: projectId,
    p_user_id: userId,
  });
  if (error !== null) return false;
  return data;
}

export const yjsRoutes: FastifyPluginAsync = async (app) => {
  const verifyToken = createTokenVerifier(app.env);

  app.get(
    '/:projectId/:fileId/socket',
    { websocket: true },
    (socket, request) => {
      const params = request.params as { projectId: string; fileId: string };
      const projectParse = projectIdSchema.safeParse(params.projectId);
      const fileParse = fileIdSchema.safeParse(params.fileId);
      if (!projectParse.success || !fileParse.success) {
        socket.close(1008, 'invalid path');
        return;
      }

      const query = request.query as { token?: string };
      const token = query.token;
      if (token === undefined) {
        socket.close(1008, 'missing token');
        return;
      }

      void (async () => {
        try {
          const payload = await verifyToken(token);
          if (payload === null) {
            socket.close(1008, 'invalid token');
            return;
          }
          const claims = payload as JwtPayload;
          const userId = claims.sub as UserId | undefined;
          if (userId === undefined) {
            socket.close(1008, 'invalid token');
            return;
          }

          if (!(await isProjectMember(request, projectParse.data, userId))) {
            socket.close(1008, 'forbidden');
            return;
          }

          const docId = `${projectParse.data}/${fileParse.data}`;
          const shared = await app.yjs.get(docId);
          shared.addConnection(socket);
          shared.sendInitialState(socket);

          socket.binaryType = 'arraybuffer';
          socket.on('message', (data: unknown) => {
            if (data instanceof ArrayBuffer) {
              shared.handleMessage(socket, new Uint8Array(data));
            } else if (data instanceof Buffer) {
              // Copy bytes into a fresh Uint8Array<ArrayBuffer> so the
              // y-protocols decoder receives a plain ArrayBuffer-backed view.
              const copy = new Uint8Array(data.byteLength);
              copy.set(data);
              shared.handleMessage(socket, copy);
            }
          });

          socket.on('close', () => {
            shared.removeConnection(socket);
            app.yjs.removeIfEmpty(docId);
          });

          // Heartbeat: send a ping every 30s; close the conn if it doesn't pong.
          let alive = true;
          socket.on('pong', () => {
            alive = true;
          });
          const heartbeat = setInterval(() => {
            if (!alive) {
              socket.terminate();
              clearInterval(heartbeat);
              return;
            }
            alive = false;
            try {
              socket.ping();
            } catch {
              /* close handler will clean up */
            }
          }, 30_000);
          socket.on('close', () => {
            clearInterval(heartbeat);
          });
        } catch (err) {
          app.log.warn({ err }, 'yjs auth failed');
          socket.close(1008, 'auth failed');
        }
      })();
    },
  );

  await Promise.resolve();
};

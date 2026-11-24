import {
  approveUser,
  listUsers,
  login,
  logout,
  register,
  rejectUser,
} from '../services/authService';
import { builder } from './builder';
import { assertWithinLimit, loginLimiter, registerLimiter, requireAdmin } from './guards';
import { UserRef } from './types';

/** Konten und Sessions: Registrierung, Login/Logout, Freischaltung durch Admins. */

builder.queryFields((t) => ({
  me: t.field({
    type: UserRef,
    nullable: true,
    resolve: (_root, _args, ctx) => ctx.currentUser,
  }),
  users: t.field({
    type: [UserRef],
    resolve: (_root, _args, ctx) => {
      requireAdmin(ctx);
      return listUsers(ctx.db);
    },
  }),
}));

builder.mutationFields((t) => ({
  register: t.field({
    type: UserRef,
    args: {
      username: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
      // Out-of-Band-Secret für die Erst-Registrierung des Bootstrap-Admins
      // (MACVIBES_ADMIN_BOOTSTRAP_TOKEN). Für alle anderen Nutzer irrelevant.
      // Der Wert darf NIE geloggt oder in Fehlermeldungen zurückgegeben werden.
      bootstrapToken: t.arg.string({ required: false }),
    },
    resolve: async (_root, args, ctx) => {
      assertWithinLimit(ctx, registerLimiter, [`ip:${ctx.clientIp ?? 'unbekannt'}`]);
      const result = await register(ctx.db, ctx.config, args);
      // Nur der konfigurierte Bootstrap-Admin (MACVIBES_ADMIN_USERNAME) ist
      // sofort freigeschaltet und bekommt eine Session. Alle anderen sind
      // pending und müssen zuerst zugelassen werden.
      if (result.session) {
        await ctx.session.write(result.session.token, result.session.expiresAt);
      }
      return result.user;
    },
  }),
  login: t.field({
    type: UserRef,
    args: {
      username: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      // VOR dem argon2-Verify prüfen — das ist der teure Teil (F14).
      assertWithinLimit(ctx, loginLimiter, [
        `ip:${ctx.clientIp ?? 'unbekannt'}`,
        `user:${args.username.toLowerCase()}`,
      ]);
      const result = await login(ctx.db, ctx.config, args.username, args.password);
      await ctx.session.write(result.token, result.expiresAt);
      return result.user;
    },
  }),
  logout: t.boolean({
    resolve: async (_root, _args, ctx) => {
      const token = await ctx.session.readToken();
      if (token) {
        await logout(ctx.db, token);
      }
      await ctx.session.clear();
      return true;
    },
  }),
  approveUser: t.field({
    type: UserRef,
    args: {
      userId: t.arg.id({ required: true }),
    },
    resolve: (_root, args, ctx) => {
      requireAdmin(ctx);
      return approveUser(ctx.db, String(args.userId));
    },
  }),
  rejectUser: t.boolean({
    args: {
      userId: t.arg.id({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      requireAdmin(ctx);
      await rejectUser(ctx.db, String(args.userId));
      return true;
    },
  }),
}));

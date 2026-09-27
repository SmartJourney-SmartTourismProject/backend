import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { KeycloakAdminService } from './keycloak-admin.service.js';

function makePrisma() {
  return {
    app_user: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    activity_log: { create: vi.fn(), findMany: vi.fn() },
  };
}

function makeKeycloak() {
  return { setAdminRole: vi.fn(), setEnabled: vi.fn() };
}

const MANAGED_TARGET = { id: 'target-1', keycloak_id: 'kc-1', role: 'traveler', is_active: true };

describe('AdminUsersService.list', () => {
  it('strips keycloak_id and replaces it with a managed boolean', async () => {
    const prisma = makePrisma();
    prisma.app_user.findMany.mockResolvedValue([{ id: 'u1', keycloak_id: 'kc-1', _count: { itinerary: 0, chat_session: 0 } }]);
    prisma.app_user.count.mockResolvedValue(1);
    const service = new AdminUsersService(prisma as unknown as PrismaService, makeKeycloak() as unknown as KeycloakAdminService);

    const result = await service.list({});

    expect(result.items[0]).not.toHaveProperty('keycloak_id');
    expect(result.items[0].managed).toBe(true);
  });

  it('flags a pre-Keycloak row (no keycloak_id) as unmanaged', async () => {
    const prisma = makePrisma();
    prisma.app_user.findMany.mockResolvedValue([{ id: 'u1', keycloak_id: null, _count: { itinerary: 0, chat_session: 0 } }]);
    prisma.app_user.count.mockResolvedValue(1);
    const service = new AdminUsersService(prisma as unknown as PrismaService, makeKeycloak() as unknown as KeycloakAdminService);

    const result = await service.list({});

    expect(result.items[0].managed).toBe(false);
  });
});

describe('AdminUsersService.update guardrails', () => {
  it('refuses to manage a user who never signed in through Keycloak', async () => {
    const prisma = makePrisma();
    prisma.app_user.findUnique.mockResolvedValue({ ...MANAGED_TARGET, keycloak_id: null });
    const keycloak = makeKeycloak();
    const service = new AdminUsersService(prisma as unknown as PrismaService, keycloak as unknown as KeycloakAdminService);

    await expect(service.update('admin-1', 'target-1', { role: 'admin' })).rejects.toThrow(BadRequestException);
    expect(keycloak.setAdminRole).not.toHaveBeenCalled();
  });

  it('refuses to let an admin demote or deactivate their own account', async () => {
    const prisma = makePrisma();
    prisma.app_user.findUnique.mockResolvedValue({ ...MANAGED_TARGET, id: 'admin-1', role: 'admin' });
    const service = new AdminUsersService(prisma as unknown as PrismaService, makeKeycloak() as unknown as KeycloakAdminService);

    await expect(service.update('admin-1', 'admin-1', { role: 'traveler' })).rejects.toThrow(BadRequestException);
    await expect(service.update('admin-1', 'admin-1', { is_active: false })).rejects.toThrow(BadRequestException);
  });

  it('404s on a target user that does not exist', async () => {
    const prisma = makePrisma();
    prisma.app_user.findUnique.mockResolvedValue(null);
    const service = new AdminUsersService(prisma as unknown as PrismaService, makeKeycloak() as unknown as KeycloakAdminService);

    await expect(service.update('admin-1', 'missing', { role: 'admin' })).rejects.toThrow(NotFoundException);
  });

  it('writes to Keycloak before mirroring the role change into app_user', async () => {
    const prisma = makePrisma();
    prisma.app_user.findUnique.mockResolvedValue(MANAGED_TARGET);
    prisma.app_user.update.mockResolvedValue(MANAGED_TARGET);
    const keycloak = makeKeycloak();
    const service = new AdminUsersService(prisma as unknown as PrismaService, keycloak as unknown as KeycloakAdminService);
    prisma.app_user.findUnique.mockResolvedValueOnce(MANAGED_TARGET).mockResolvedValueOnce({ ...MANAGED_TARGET, role: 'admin' });

    await service.update('admin-1', 'target-1', { role: 'admin' });

    expect(keycloak.setAdminRole).toHaveBeenCalledWith('kc-1', true);
    expect(prisma.app_user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'admin' }) }),
    );
  });

  it('is a no-op (no Keycloak call, no DB write) when nothing actually changed', async () => {
    const prisma = makePrisma();
    prisma.app_user.findUnique.mockResolvedValue(MANAGED_TARGET);
    const keycloak = makeKeycloak();
    const service = new AdminUsersService(prisma as unknown as PrismaService, keycloak as unknown as KeycloakAdminService);

    await service.update('admin-1', 'target-1', { role: 'traveler' });

    expect(keycloak.setAdminRole).not.toHaveBeenCalled();
    expect(prisma.app_user.update).not.toHaveBeenCalled();
  });
});

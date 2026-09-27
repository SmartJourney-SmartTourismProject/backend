import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

function context(): ExecutionContext {
  return { getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  it('lets a @Public() route through without checking for a token', () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => key === IS_PUBLIC_KEY);
    // Any real passport call here would need a live strategy - the point of
    // this test is that a public route never reaches that code path at all.
    const superSpy = vi.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate');
    const guard = new JwtAuthGuard(reflector);

    expect(guard.canActivate(context())).toBe(true);
    expect(superSpy).not.toHaveBeenCalled();
    superSpy.mockRestore();
  });

  it('delegates to the passport strategy for a non-public route', () => {
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const superSpy = vi.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate').mockReturnValue(true);
    const guard = new JwtAuthGuard(reflector);

    expect(guard.canActivate(context())).toBe(true);
    expect(superSpy).toHaveBeenCalledTimes(1);
    superSpy.mockRestore();
  });
});

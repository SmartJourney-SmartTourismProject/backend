import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { passportJwtSecret } from 'jwks-rsa';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../users/users.service.js';
import { KeycloakTokenClaims } from './keycloak-token.js';

/**
 * Validates Keycloak access tokens offline: RS256 signature against the
 * realm's JWKS (cached, rate-limited), plus issuer and audience. No call to
 * Keycloak per request. The audience check is what stops a token minted for
 * some other client in the realm from being accepted here - see
 * keycloak-token.ts for where `smartjourney-api` comes from.
 *
 * Env: KEYCLOAK_ISSUER (e.g. http://localhost:8081/realms/smartjourney),
 * KEYCLOAK_AUDIENCE (default smartjourney-api).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'keycloak-jwt') {
  constructor(private readonly users: UsersService) {
    const issuer = process.env.KEYCLOAK_ISSUER;
    if (!issuer) {
      throw new Error('KEYCLOAK_ISSUER is not set - see backend/.env.example');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      issuer,
      audience: process.env.KEYCLOAK_AUDIENCE ?? 'smartjourney-api',
      algorithms: ['RS256'],
      secretOrKeyProvider: passportJwtSecret({
        jwksUri: `${issuer}/protocol/openid-connect/certs`,
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
      }),
    });
  }

  /** Runs only after signature/iss/aud/exp all passed. */
  async validate(claims: KeycloakTokenClaims) {
    if (!claims.sub) {
      throw new UnauthorizedException('Token has no subject');
    }
    return this.users.ensureFromToken(claims);
  }
}

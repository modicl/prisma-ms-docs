import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { Request } from "express";

/**
 * Roles reales del sistema. Cognito agrega AUTOMATICAMENTE un grupo por cada IdP
 * federado, con formato `<userPoolId>_<Provider>` (en este pool:
 * `us-east-1_h1uG5pYAS_Google`). Eso NO es un rol.
 *
 * Por eso el rol se resuelve por lista blanca y nunca con `groups[0]`.
 * Misma logica que `prisma-front/src/services/cognitoAuth.js`.
 */
const ROLES = ["SUPERADMIN", "ADMIN", "TEACHER"] as const;

/**
 * PENDING no es un grupo de Cognito: es la AUSENCIA de uno. Cualquiera puede
 * registrarse con Google o Microsoft, asi que un token valido NO alcanza para
 * tener acceso; hace falta que un admin asigne un grupo. El default era
 * TEACHER, lo que convertia a cualquier cuenta de Google en docente.
 */
const PENDING_ROLE = "PENDING";
const DEFAULT_ROLE = PENDING_ROLE;

const resolveRole = (groups: unknown): string => {
  const list = Array.isArray(groups) ? groups : [];
  return ROLES.find((role) => list.includes(role)) ?? DEFAULT_ROLE;
};

@Injectable()
export class CognitoAuthGuard implements CanActivate {
  private readonly logger = new Logger(CognitoAuthGuard.name);
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>("COGNITO_REGION", "us-east-1");
    const userPoolId = this.configService.getOrThrow<string>("COGNITO_USER_POOL_ID");
    this.audience = this.configService.getOrThrow<string>("COGNITO_CLIENT_ID");
    this.issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    this.jwks = createRemoteJWKSet(
      new URL(`${this.issuer}/.well-known/jwks.json`),
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: unknown }>();
    const authorization = request.headers.authorization;

    if (!authorization) {
      throw new UnauthorizedException("Authorization header is required.");
    }

    const [scheme, token] = authorization.split(" ");

    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new UnauthorizedException("Invalid Authorization header.");
    }

    // El catch solo envuelve la verificacion de firma: si tambien cubriera los
    // chequeos de abajo, convertiria el 403 de PENDING en un 401 generico.
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ["RS256"],
      }));
    } catch (err) {
      this.logger.error(`JWT verification failed: ${(err as Error).message}`);
      throw new UnauthorizedException("Invalid or expired token.");
    }

    // El front manda el ID TOKEN, no el access token: es el unico que trae
    // `email` y `name` (decision documentada en cognitoAuth.js). El access
    // token ademas no lleva `aud`, asi que ni pasaria la validacion de arriba.
    if (payload["token_use"] !== "id") {
      throw new UnauthorizedException("Expected an ID token.");
    }

    const role = resolveRole(payload["cognito:groups"]);

    // Choke point unico: cortar aca cubre tambien los endpoints que no
    // declaran RolesGuard, que de otro modo quedarian abiertos a cualquiera
    // que se registre con una cuenta de Google.
    if (role === PENDING_ROLE) {
      throw new ForbiddenException(
        "Account pending authorization. Contact your administrator.",
      );
    }

    const colegioId = payload["custom:colegioId"];

    request.user = {
      id: payload.sub,
      email: payload["email"],
      // `role` y `appRole` con el MISMO valor a proposito: RolesGuard evalua
      // `appRole ?? role`, y con Supabase `role` traia el literal
      // "authenticated", que no matcheaba ningun rol de la app.
      role,
      appRole: role,
      colegioId:
        typeof colegioId === "string" && colegioId !== "" ? colegioId : null,
    };
    return true;
  }
}

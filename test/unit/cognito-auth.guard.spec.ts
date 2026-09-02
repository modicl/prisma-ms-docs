import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jwtVerify } from 'jose';
import { CognitoAuthGuard } from '../../src/auth/guards/cognito-auth.guard';

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => 'mock-jwks'),
  jwtVerify: jest.fn(),
}));

const mockedJwtVerify = jwtVerify as unknown as jest.Mock;

const CONFIG: Record<string, string> = {
  COGNITO_REGION: 'us-east-1',
  COGNITO_USER_POOL_ID: 'us-east-1_h1uG5pYAS',
  COGNITO_CLIENT_ID: '76b244eh09k8tto893sqeron6m',
};

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_h1uG5pYAS';

// El grupo que Cognito agrega solo por tener Google como IdP federado.
const IDP_GROUP = 'us-east-1_h1uG5pYAS_Google';

describe('CognitoAuthGuard', () => {
  let guard: CognitoAuthGuard;
  let request: { headers: { authorization?: string }; user?: any };

  const payload = (over: Record<string, unknown> = {}) => ({
    sub: 'cognito-sub-1',
    email: 'docente@colegio.cl',
    token_use: 'id',
    ...over,
  });

  const context = (authorization?: string): ExecutionContext => {
    request = { headers: { authorization } };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const configService = {
      get: jest.fn((key: string, fallback?: string) => CONFIG[key] ?? fallback),
      getOrThrow: jest.fn((key: string) => CONFIG[key]),
    } as unknown as ConfigService;
    guard = new CognitoAuthGuard(configService);
  });

  it('rechaza si falta el header Authorization', async () => {
    await expect(guard.canActivate(context(undefined))).rejects.toThrow(UnauthorizedException);
  });

  it('rechaza un scheme que no sea Bearer', async () => {
    await expect(guard.canActivate(context('Basic abc123'))).rejects.toThrow(UnauthorizedException);
  });

  it('verifica contra el issuer, el client id y RS256 de Cognito', async () => {
    mockedJwtVerify.mockResolvedValue({
      payload: payload({ 'cognito:groups': ['TEACHER'] }),
    });

    await expect(guard.canActivate(context('Bearer token'))).resolves.toBe(true);

    expect(mockedJwtVerify).toHaveBeenCalledWith('token', 'mock-jwks', {
      issuer: ISSUER,
      audience: '76b244eh09k8tto893sqeron6m',
      algorithms: ['RS256'],
    });
  });

  it('resuelve el rol por lista blanca e ignora el grupo del IdP federado', async () => {
    mockedJwtVerify.mockResolvedValue({
      payload: payload({ 'cognito:groups': [IDP_GROUP, 'SUPERADMIN'] }),
    });

    await guard.canActivate(context('Bearer token'));

    // Con groups[0] habria salido el grupo autogenerado de Google.
    expect(request.user.role).toBe('SUPERADMIN');
    expect(request.user.appRole).toBe('SUPERADMIN');
  });

  // El default es PENDING (sin acceso), no TEACHER: cualquiera puede
  // registrarse con Google, asi que un token valido no alcanza para entrar.
  it('rechaza con 403 si el unico grupo es el del IdP federado', async () => {
    mockedJwtVerify.mockResolvedValue({
      payload: payload({ 'cognito:groups': [IDP_GROUP] }),
    });

    await expect(guard.canActivate(context('Bearer token'))).rejects.toThrow(ForbiddenException);
    expect(request.user).toBeUndefined();
  });

  it('rechaza con 403 si no viene el claim cognito:groups', async () => {
    mockedJwtVerify.mockResolvedValue({ payload: payload() });

    await expect(guard.canActivate(context('Bearer token'))).rejects.toThrow(ForbiddenException);
  });

  it('el 403 de PENDING no queda tapado como 401 por el catch', async () => {
    mockedJwtVerify.mockResolvedValue({ payload: payload() });

    await expect(guard.canActivate(context('Bearer token'))).rejects.not.toThrow(
      UnauthorizedException,
    );
  });

  it('mapea custom:colegioId al tenant', async () => {
    mockedJwtVerify.mockResolvedValue({
      payload: payload({
        'cognito:groups': ['TEACHER'],
        'custom:colegioId': 'colegio-uuid-1',
      }),
    });

    await guard.canActivate(context('Bearer token'));

    expect(request.user.colegioId).toBe('colegio-uuid-1');
    expect(request.user.id).toBe('cognito-sub-1');
    expect(request.user.email).toBe('docente@colegio.cl');
  });

  it('deja colegioId en null si el claim no viene o viene vacio', async () => {
    mockedJwtVerify.mockResolvedValue({
      payload: payload({ 'cognito:groups': ['TEACHER'] }),
    });
    await guard.canActivate(context('Bearer token'));
    expect(request.user.colegioId).toBeNull();

    mockedJwtVerify.mockResolvedValue({
      payload: payload({ 'cognito:groups': ['TEACHER'], 'custom:colegioId': '' }),
    });
    await guard.canActivate(context('Bearer token'));
    expect(request.user.colegioId).toBeNull();
  });

  it('rechaza un access token (token_use != id)', async () => {
    mockedJwtVerify.mockResolvedValue({ payload: payload({ token_use: 'access' }) });

    await expect(guard.canActivate(context('Bearer token'))).rejects.toThrow(UnauthorizedException);
  });

  it('rechaza si la verificacion de firma falla', async () => {
    mockedJwtVerify.mockRejectedValue(new Error('signature verification failed'));

    await expect(guard.canActivate(context('Bearer token'))).rejects.toThrow(UnauthorizedException);
  });
});

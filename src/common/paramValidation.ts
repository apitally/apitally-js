export function isValidClientId(clientId: string): boolean {
  const regexExp =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regexExp.test(clientId);
}

export function isValidEnv(env: string): boolean {
  const regexExp = /^[\w-]{1,32}$/;
  return regexExp.test(env);
}

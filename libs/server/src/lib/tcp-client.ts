import { ClientProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

export function createTcpClient(port: number): ClientProxy {
  return ClientProxyFactory.create({
    transport: Transport.TCP,
    options: { host: '127.0.0.1', port },
  });
}

export async function sendTo<T>(
  client: ClientProxy,
  pattern: string,
  payload: unknown,
  timeoutMs = 10 * 60_000,
): Promise<T> {
  await client.connect();
  return firstValueFrom(
    client.send<T>(pattern, payload).pipe(timeout(timeoutMs)),
  );
}

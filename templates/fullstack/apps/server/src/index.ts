import { createYoga } from 'graphql-yoga';
import { schema } from './graphql/schema';

const yoga = createYoga({ schema, graphqlEndpoint: '/graphql' });

const server = Bun.serve({
  port: 4000,
  fetch: (request) => yoga.fetch(request),
});

console.log(`GraphQL-Server läuft auf http://localhost:${server.port}/graphql`);

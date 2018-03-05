import {assert} from "chai";
import {Rpc} from "../lib/rpc";

interface ICalc {
  add(x: number, y: number): number;
}

class Calc implements ICalc {
  public add(x: number, y: number): number {
    return x + y;
  }
}

interface IGreet {
  getGreeting(name: string): Promise<string>;
}

class MyGreeting implements IGreet {
  public async getGreeting(name: string): Promise<string> { return `Hello, ${name}!`; }
}

describe("ts-rpc", () => {

  it("should be able to make unchecked stubs and call methods", async () => {
    const rpc = new Rpc();
    rpc.start((msg) => rpc.receiveMessage(msg));
    rpc.registerImpl<ICalc>("calc", new Calc());
    const stub = rpc.getStub<ICalc>("calc");
    assert(stub);
    assert.equal(await stub.add(4, 5), 9);
  });

  it("should support hello world without a checker", async () => {
    const aRpc = new Rpc();
    const bRpc = new Rpc();
    aRpc.start((msg) => bRpc.receiveMessage(msg));
    bRpc.start((msg) => aRpc.receiveMessage(msg));
    aRpc.registerImpl("my-greeting", new MyGreeting());
    const stub = bRpc.getStub<IGreet>("my-greeting");
    assert.equal(await stub.getGreeting("World"), "Hello, World!");
  });

  describe("pipe", () => {

    const A: IEndpoint = {name: "a", to: {}};
    const B: IEndpoint = {name: "b", to: {}};
    const C: IEndpoint = {name: "c", to: {}};
    const D: IEndpoint = {name: "d", to: {}};
    const linkedEndpoints: IEndpoint[][] = [];

    for (const [a, b] of [[A, B], [A, C], [D, B]]) {
      linkEndpoints(a, b);
    }

    pipeEndpointsThrough(B, C, {through: A});
    pipeEndpointsThrough(D, C, {through: B});

    describe("should create valid rpcs", () => {
      for (const [a, b] of linkedEndpoints) {
        describe(`${formatEndpoints(a, b)} should be valid`, () => basicTests(a, b));
      }
    });

    function pipeEndpointsThrough(a: IEndpoint, b: IEndpoint, {through: c}: {through: IEndpoint}) {
      const name = a.name + "2" + b.name;
      Rpc.pipe(name, c.to[a.name], c.to[b.name]);
      a.to[b.name] = Rpc.pipeEndpoint(name, b.to[c.name]);
      b.to[a.name] = Rpc.pipeEndpoint(name, a.to[c.name]);
      linkedEndpoints.push([a, b]);
    }

    function linkEndpoints(a: IEndpoint, b: IEndpoint) {
      [a.to[b.name], b.to[a.name]] = createRpcPair();
      linkedEndpoints.push([a, b]);
    }

  });

});

async function assertHelloWorld(aRpc: Rpc, bRpc: Rpc) {
  aRpc.unregisterImpl("my-greeting");
  aRpc.registerImpl("my-greeting", new MyGreeting());
  const stub = bRpc.getStub<IGreet>("my-greeting");
  assert.equal(await stub.getGreeting("World"), "Hello, World!");
}

function createRpcPair(): [Rpc, Rpc] {
  const aRpc = new Rpc();
  const bRpc = new Rpc();
  aRpc.start((msg) => bRpc.receiveMessage(msg));
  bRpc.start((msg) => aRpc.receiveMessage(msg));
  return [aRpc, bRpc];
}

/**
 * basicTests includes a limited set of unit-test that are selected to check wether an rpc channel
 * is valid. In particular, basicTests is used for testing rpc pipes and it is then used many times
 * over differents channels piped into each other. Including all the tests, or including long tests
 * could significantly slow down the execution time.
 */
function basicTests(A: IEndpoint, B: IEndpoint) {
  const aRpc = A.to[B.name];
  const bRpc = B.to[A.name];

  it("should support hello world", async () => {
    await assertHelloWorld(aRpc, bRpc);
  });

  it("should support calling function", async () => {
    aRpc.unregisterFunc("foo");
    aRpc.registerFunc("foo", async (name: string) => `Yo ${name}!`);
    assert.equal(await bRpc.callRemoteFunc("foo", "Santa"), "Yo Santa!");
  });
}

// some test internal types
interface IEndpoint {
  name: string;
  to: {[name: string]: Rpc};
}

function formatEndpoints(a: IEndpoint, b: IEndpoint) {
  return `${formatEndpoint(a)} to ${formatEndpoint(b)}`;
}

function formatEndpoint(a: IEndpoint): string {
  return `(${a.name.toUpperCase()})`;
}

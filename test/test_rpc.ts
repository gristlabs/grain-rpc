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

    function pipeEndpointsThrough(a: IEndpoint, b: IEndpoint, {through: c}: {through: IEndpoint}) {
      const a2b = a.name + "2" + b.name;
      Rpc.pipe(a2b, c.to[a.name], c.to[b.name]);
      a.to[b.name] = Rpc.pipeEndpoint(a2b, b.to[c.name]);
      b.to[a.name] = Rpc.pipeEndpoint(a2b, a.to[c.name]);
    }

    const A: IEndpoint = {name: "a", to: {}};
    const B: IEndpoint = {name: "b", to: {}};
    const C: IEndpoint = {name: "c", to: {}};

    linkEndpoints(A, B);
    linkEndpoints(A, C);
    pipeEndpointsThrough(B, C, {through: A});

    describe("(B) to (C) through (A)", () => {
      shouldBeValid(B, C);
      shouldNotBreak([A, C], [A, B]);
    });

    describe("more complex pipes: (D) to (C) though (B)", () => {

      const D: IEndpoint = {name: "d", to: {}};

      linkEndpoints(D, B);
      pipeEndpointsThrough(D, C, {through: B});

      shouldBeValid(D, C);
      shouldNotBreak([A, C], [A, B], [B, C], [B, D]);
    });

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

function linkEndpoints(A: IEndpoint, B: IEndpoint) {
  [A.to[B.name], B.to[A.name]] = createRpcPair();
}

// some test internal types
interface IEndpoint {
  name: string;
  to: {[name: string]: Rpc};
}

function shouldBeValid(a: IEndpoint, b: IEndpoint) {
  describe(`Should be valid ${formatEndpoints(a, b)}`, () => basicTests(a, b));
}

function shouldNotBreak(...abs: IEndpoint[][]) {
  for (const [a, b] of abs) {
    describe(`should not break ${formatEndpoints(a, b)}`, () => basicTests(a, b));
  }
}

function formatEndpoints(a: IEndpoint, b: IEndpoint) {
  return `${formatEndpoint(a)} to ${formatEndpoint(b)}`;
}

function formatEndpoint(a: IEndpoint): string {
  return `(${a.name.toUpperCase()})`;
}

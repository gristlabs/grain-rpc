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
    const [AtoB, BtoA] = createRpcPair();
    const [AtoC, CtoA] = createRpcPair();
    const [DtoB, BtoD] = createRpcPair();

    Rpc.pipe("b2c", AtoB, AtoC);
    const CtoB = Rpc.pipeEndpoint("b2c", CtoA);
    const BtoC = Rpc.pipeEndpoint("b2c", BtoA);

    Rpc.pipe("d2c", BtoD, BtoC);
    const DtoC = Rpc.pipeEndpoint("d2c", DtoB);
    const CtoD = Rpc.pipeEndpoint("d2c", CtoB);

    describe("should create valid rpcs", () => {
      describe(`A to B should be valid`, () => basicTests(AtoB, BtoA));
      describe(`A to C should be valid`, () => basicTests(AtoC, CtoA));
      describe(`D to B should be valid`, () => basicTests(DtoB, BtoD));
      describe(`B to C should be valid`, () => basicTests(BtoC, CtoB));
      describe(`D to C should be valid`, () => basicTests(DtoC, CtoD));
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

/**
 * basicTests includes a limited set of unit-test that are selected to check wether an rpc channel
 * is valid. In particular, basicTests is used for testing rpc pipes and it is then used many times
 * over differents channels piped into each other. Including all the tests, or including long tests
 * could significantly slow down the execution time.
 */
function basicTests(aRpc: Rpc, bRpc: Rpc) {

  it("should support hello world", async () => {
    await assertHelloWorld(aRpc, bRpc);
  });

  it("should support calling function", async () => {
    aRpc.unregisterFunc("foo");
    aRpc.registerFunc("foo", async (name: string) => `Yo ${name}!`);
    assert.equal(await bRpc.callRemoteFunc("foo", "Santa"), "Yo Santa!");
  });
}

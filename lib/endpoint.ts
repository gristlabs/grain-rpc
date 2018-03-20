/**
 *
 * Implement basic routing of messages across a network of links.
 * Endpoints have names that are unique across the network.
 * The network is composed of nodes, with links between the nodes.
 * Each node keeps track of which endpoints are reachable via
 * which link, so that it can incrementally move messages along
 * to their named destination.  Messages have an envelope that
 * declares the endpoint they should be delivered to, and the
 * endpoint to which any reply should be delivered back to.
 *
 * To use:
 *  - Instantiate a Node object in each distinct computational element.
 *  - Call node.addOutput to tell the node how to send data to neigboring
 *    nodes.
 *  - Call node.listen(rpc, name) to place the rpc element as an endpoint
 *    on the network, with the given endpoint name.
 *  - Anywhere else in the network, call node.connect(rpc, name, target) to
 *    place the rpc on the network with the given endpoint `name`, and to hook
 *    it up to talk to the endpoint called `target` as if they were on other
 *    ends of a simple channel.
 *
 * Limitations:
 * The current routing "algorithm" is just a sketch.  Each connected node ends
 * up with an entry for each endpoint on the network, which is inefficient.
 * There is no provision for endpoints leaving the network.  Undeliverable
 * messages will just stall in a queue waiting for an endpoint to show up.
 *
 */


import {IMessage, MsgType} from "./message";
import {Rpc, SendMessageCB} from "./rpc";

/**
 * Routing information for messages in transit - where they are going to, and where they
 * came from.
 *
 */
export interface IEnvelope {
  destEndpoint: string;
  srcEndpoint: string;
}

/**
 * All the links one node has that lead to neighboring nodes.
 */
export class Link {
  /** Endpoints reachable through this link, and their cost */
  public distances = new Map<string, number>();

  public constructor(public name: string,  // link name should be unique within node
                     public sendMessage: SendMessageCB,  // callback for sending data
                     public cost: number,  // cost of transmission across this link
                     public node: Node) {  // node that owns this link
  }

  /** Receive a message from this link */
  public receiveMessage(msg: any): void {
    this.node.receiveInput(name, msg);
  }
}

/**
 * End consumers/generators of messages that are attached to a specific node.
 */
export class Endpoint {
  public constructor(public name: string,  // endpoint name, unique across network
                     public dest: Rpc,     // rpc object used for communication
                     public node: Node,    // node to which endpoint is attached
                     public target?: string) {  // name of endpoint we communicate with,
                                           // if we initiate communcation.
  }

  public async recv(msg: any): Promise<void> {
    if (!this.target) {
      throw new Error("nowhere to send message");
    }
    return this.node.deliver(msg, {
      destEndpoint: this.target,
      srcEndpoint: name
    });
  }
}

/**
 * A routing element that communicates with its peers in order to deliver messages
 * and replies to and from named endpoints.
 */
export class Node {
  public links = new Map<string, Link>();  // connections to peers, by link name
  public steps = new Map<string, Link>();  // connections to peers, by endpoint
  public mine = new Map<string, Endpoint>(); // endpoints attached to this node
  public _queue = new Array<any>(); // queue of messages not yet deliverable

  public constructor(public nodeName: string) {  // nodename is decorative only
  }

  /**
   * Give an rpc endpoint a routable name on the network.
   * Optionally, declare a target endpoint to which any traffic it
   * initiates should be routed to.
   */
  public listen(rpc: Rpc, name: string, target?: string): void {
    const listener = new Endpoint(name, rpc, this, target);
    this.mine.set(name, listener);
    for (const link of this.links.values()) {
      // tell neigbors about this endpoint
      link.sendMessage({
        mtype: MsgType.Custom,
        data: null,
        name: name,
        cost: 0.0
      } as IMessage);
    }
    rpc.start((msg: any) => {
      if (!target) {
        throw new Error("Cannot ship data without a target");
      }
      this.deliver(msg, {
        destEndpoint: target,
        srcEndpoint: name
      });
    });
    this.update();
  }

  /** name an endpoint with the express purpose of talking to a named target */
  public connect(rpc: Rpc, name: string, target: string): void {
    this.listen(rpc, name, target);
    this.update();
  }

  /** 
   * deliver a message to its target, or move it one step along, or enqueue it for
   * when a route becomes available
   */
  public async deliver(msg: any, env: IEnvelope): Promise<void> {
    msg.msgEnvelope = env;
    const me = this.mine.get(env.destEndpoint);
    if (me) {
      const altEnv: IEnvelope = {
        destEndpoint: env.srcEndpoint,
        srcEndpoint: env.destEndpoint
      };
      return me.dest.receiveMessage(msg, (reply: any) => this.deliver(reply, altEnv));
    }
    const step = this.steps.get(env.destEndpoint);
    if (step) {
      step.sendMessage(msg);
    } else {
      this._queue.push(msg);
    }
  }

  /**
   * Add an output from this node to a neigboring node.
   */
  public addOutput(linkName: string, sendMessage: SendMessageCB, cost: number): Link {
    const link = new Link(linkName, sendMessage, cost, this);
    this.links.set(linkName, link);
    for (const listener of this.mine.values()) {
      link.sendMessage({
        mtype: MsgType.Custom,
        data: null,
        name: listener.name,
        cost: 0.0
      } as IMessage);
    }
    for (const [name, step] of this.steps.entries()) {
      link.sendMessage({
        mtype: MsgType.Custom,
        data: null,
        name: name,
        cost: step.distances.get(name),
      } as IMessage);
    }
    this.update();
    return link;
  }

  /**
   * Receive input from a neighboring node.
   */
  public receiveInput(linkName: string, data: any): void {
    const link = this.links.get(linkName);
    if (!link) {
      throw new Error(`unknown link ${linkName} for node ${this.nodeName}`);
    }
    if (data.msgEnvelope) {
      this.deliver(data, data.msgEnvelope);
      return;
    }
    if (data.name) {
      if (this.mine.get(data.name)) {
        // this post does not interest us.
        return;
      }
      let cost = data.cost + link.cost;
      const prevLink = this.steps.get(data.name);
      if (prevLink) {
        const prevCost = prevLink.distances.get(data.name);
        if (prevCost! < cost) {
          // this post does not interest us.
          return;
        }
      }
      link.distances.set(data.name, cost);
      this.steps.set(data.name, link);

      for (const altLink of this.links.values()) {
        if (altLink.name !== linkName) {
          altLink.sendMessage({
            mtype: MsgType.Custom,
            data: null,
            name: data.name,
            cost,
          } as IMessage);
        }
      }
      this.update();
    }
  }

  /** routing has changed, see if we can pass along any messages */
  public update() {
    const pending: Array<any> = this._queue.splice(0);
    for (const msg of pending) {
      this.deliver(msg, msg.msgEnvelope);
    }
  }
}


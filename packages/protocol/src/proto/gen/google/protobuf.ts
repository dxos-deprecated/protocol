import { Schema as CodecSchema } from "@dxos/codec-protobuf";
import { DecodedAny, KnownAny } from "../../any";
import * as dxos_protocol from "../dxos/protocol";
export interface Any {
    type_url?: string;
    value?: Uint8Array;
}

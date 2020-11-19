import { Schema } from "@dxos/codec-protobuf";
import substitutions from "../substitutions";
import { Schema as CodecSchema } from "@dxos/codec-protobuf";
import { DecodedAny, KnownAny } from "../any";
import * as dxos_protocol from "./dxos/protocol";
import * as google_protobuf from "./google/protobuf";
export interface TYPES {
    "dxos.protocol.Message": dxos_protocol.Message;
    "dxos.protocol.Error": dxos_protocol.Error;
    "dxos.protocol.Buffer": dxos_protocol.Buffer;
    "google.protobuf.Any": google_protobuf.Any;
}
export const schemaJson = JSON.parse("{\"nested\":{\"dxos\":{\"nested\":{\"protocol\":{\"nested\":{\"Message\":{\"fields\":{\"nmId\":{\"type\":\"string\",\"id\":1},\"nmResponse\":{\"type\":\"bool\",\"id\":2},\"nmEphemeral\":{\"type\":\"bool\",\"id\":3},\"nmData\":{\"type\":\"google.protobuf.Any\",\"id\":4}}},\"Error\":{\"fields\":{\"code\":{\"type\":\"string\",\"id\":1},\"message\":{\"type\":\"string\",\"id\":2}}},\"Buffer\":{\"fields\":{\"data\":{\"type\":\"bytes\",\"id\":1}}}}}}},\"google\":{\"nested\":{\"protobuf\":{\"nested\":{\"Any\":{\"fields\":{\"type_url\":{\"type\":\"string\",\"id\":1},\"value\":{\"type\":\"bytes\",\"id\":2}}}}}}}}}");
export const schema = Schema.fromJson<TYPES>(schemaJson, substitutions);

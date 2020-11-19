import { Schema as CodecSchema } from "@dxos/codec-protobuf";
import { DecodedAny, KnownAny } from "../../any";
import * as google_protobuf from "../google/protobuf";
export interface Message {
    nmId?: string;
    nmResponse?: boolean;
    nmEphemeral?: boolean;
    nmData?: KnownAny;
}
export interface Error {
    code?: string;
    message?: string;
}
export interface Buffer {
    data?: Uint8Array;
}

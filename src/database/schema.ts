import { Schema } from 'mongoose';
import { randomUUID } from 'node:crypto';
export const required = {type:String,required:true};
export const date = {type:Date,required:true};
export const scope = {workspaceId:required};
export function schema(fields:Record<string,unknown>):Schema { return new Schema({_id:{type:String,default:randomUUID},...fields},{timestamps:true,versionKey:false,strict:'throw'}); }

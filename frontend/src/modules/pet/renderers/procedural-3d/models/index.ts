/**
 * 模型注册表：模型 id → PetModel3D（渲染器外壳按 id 取模型）。
 *
 * 新增模型三步：① models/ 下新建文件（造型参数内联 + build/applyExtras）；
 * ② 在本文件 import 并加入 MODELS；③ config.ts 的 PetModelId 加 id。
 * （将来由"角色系统"统一管理模型/角色选择，见设计文档 §4.6。）
 */
import type { PetModel3D, PetModelId } from '../config'
import { PENGUIN_3D_MODEL } from './penguin'
import { RABBIT_3D_MODEL } from './rabbit'

const MODELS: Record<PetModelId, PetModel3D> = {
  penguin: PENGUIN_3D_MODEL,
  rabbit: RABBIT_3D_MODEL
}

/** 按 id 取模型（id 类型受限，无需兜底） */
export function getPetModel3D(id: PetModelId): PetModel3D {
  return MODELS[id]
}

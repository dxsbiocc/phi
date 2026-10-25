import { basicEngineContract } from './engine-contract/basic-suite'
import { createKernelFixture } from './engine-contract/kernel-factory'

basicEngineContract('KernelProtocol', createKernelFixture)

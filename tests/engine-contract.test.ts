import { createInProcessFixture } from './engine-contract/in-process-factory'
import { engineContract } from './engine-contract/suite'

engineContract('InProcessEngine', createInProcessFixture)

import type { LocalizedCopy } from '../../../lib/i18n'
import type { missingToolPromptEnglish } from './missingToolPromptCopy.en'

export const missingToolPromptChinese: LocalizedCopy<typeof missingToolPromptEnglish> = {
  requiredToolNotFound: '缺少必需工具',
  requiredToolNotFoundValue: (tool: string) => `缺少必需工具：${tool}`,
  phiNeedsThisToolBeforeThePausedActionCanContinue: 'Phi 需要此工具才能继续已暂停的操作。',
  requiredTool: '必需工具',
  foundCandidates: '找到的候选路径',
  noCandidatesFound: '未找到候选路径，请手动输入路径。',
  chooseCandidate: '选择候选路径',
  useSelectedCandidate: '使用所选路径',
  enterAPath: '输入路径',
  environmentFolderOrAbsoluteExecutablePath: '环境目录或可执行文件的绝对路径',
  pathHelp: '请输入环境或安装目录，或者可执行文件的绝对路径。',
  useThisPath: '使用此路径',
  pathNotAccepted: (path: string) => `路径 ${path} 未被接受。`,
  rejectReason: {
    'path-must-be-absolute': '请输入以 / 开头的绝对路径。',
    'invalid-path': '路径中包含 Phi 无法使用的字符。',
    'not-executable': '该路径不是可执行文件，目录下也没有对应工具的 bin/ 入口。',
    'host-check-failed': '服务器未及时响应检查，请重试。',
    'no-version': 'Phi 运行该程序时没有得到版本号。',
    'java-too-old': 'Nextflow 需要同一环境中的 Java 17 或更高版本。'
  },
  installANewEnvironment: '安装新环境',
  installIsNeverAutomatic: '只有在你查看摘要并确认后，Phi 才会安装；不会更改你自己的 Conda 环境。',
  environment: '环境',
  what: '安装内容',
  where: '安装位置',
  approximateSize: '预计大小',
  reviewInstallation: '查看安装摘要',
  confirmInstallation: '确认安装',
  back: '返回',
  cancel: '取消',
  source: {
    saved: '已保存路径',
    path: '登录 PATH',
    conda: 'Conda 环境',
    micromamba: 'Micromamba 环境',
    phi: 'Phi 管理的环境',
    common: '常用位置'
  }
}

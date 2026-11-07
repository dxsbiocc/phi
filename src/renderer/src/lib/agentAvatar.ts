import alphaAvatarUrl from '../assets/agents/alpha.webp'
import betaAvatarUrl from '../assets/agents/beta.webp'
import chiAvatarUrl from '../assets/agents/chi.webp'
import deltaAvatarUrl from '../assets/agents/delta.webp'
import epsilonAvatarUrl from '../assets/agents/epsilon.webp'
import etaAvatarUrl from '../assets/agents/eta.webp'
import gammaAvatarUrl from '../assets/agents/gamma.webp'
import iotaAvatarUrl from '../assets/agents/iota.webp'
import kappaAvatarUrl from '../assets/agents/kappa.webp'
import lambdaAvatarUrl from '../assets/agents/lambda.webp'
import muAvatarUrl from '../assets/agents/mu.webp'
import nuAvatarUrl from '../assets/agents/nu.webp'
import omegaAvatarUrl from '../assets/agents/omega.webp'
import omicronAvatarUrl from '../assets/agents/omicron.webp'
import phiAvatarUrl from '../assets/agents/phi.webp'
import piAvatarUrl from '../assets/agents/pi.webp'
import psiAvatarUrl from '../assets/agents/psi.webp'
import rhoAvatarUrl from '../assets/agents/rho.webp'
import sigmaAvatarUrl from '../assets/agents/sigma.webp'
import tauAvatarUrl from '../assets/agents/tau.webp'
import thetaAvatarUrl from '../assets/agents/theta.webp'
import upsilonAvatarUrl from '../assets/agents/upsilon.webp'
import xiAvatarUrl from '../assets/agents/xi.webp'
import zetaAvatarUrl from '../assets/agents/zeta.webp'
import { greekSymbolForRunName } from '../../../shared/agentAvatar'

const GREEK_AVATAR_URLS: Readonly<Record<string, string>> = {
  α: alphaAvatarUrl,
  β: betaAvatarUrl,
  γ: gammaAvatarUrl,
  δ: deltaAvatarUrl,
  ε: epsilonAvatarUrl,
  ζ: zetaAvatarUrl,
  η: etaAvatarUrl,
  θ: thetaAvatarUrl,
  ι: iotaAvatarUrl,
  κ: kappaAvatarUrl,
  λ: lambdaAvatarUrl,
  μ: muAvatarUrl,
  ν: nuAvatarUrl,
  ξ: xiAvatarUrl,
  ο: omicronAvatarUrl,
  π: piAvatarUrl,
  ρ: rhoAvatarUrl,
  σ: sigmaAvatarUrl,
  τ: tauAvatarUrl,
  υ: upsilonAvatarUrl,
  χ: chiAvatarUrl,
  ψ: psiAvatarUrl,
  ω: omegaAvatarUrl
}

/** Returns the bundled artwork for a run name, falling back to Phi for non-General agents. */
export function agentAvatarUrlForDisplayName(displayName: string): string {
  const symbol = greekSymbolForRunName(displayName)?.charAt(0)
  return (symbol && GREEK_AVATAR_URLS[symbol]) || phiAvatarUrl
}

/** Converts General run names for display without changing persisted English identifiers. */
export function agentDisplayLabel(displayName: string): string {
  return greekSymbolForRunName(displayName) ?? displayName
}

---
layout: page
title: Cosmic Neutrinos
description: Using cosmological simulations to understand the effects on neutrino mass on cosmic structure
img: assets/img/illustris.jpg
importance: 1
category: work
---

The Nobel prize winning discovery of neutrino oscillations gave evidence for neutrino mass, a phenomenon beyond the Standard Model of particle physics. Measuring the neutrino mass is an integral step towards understanding the underlying mass generation mechanism. Neutrinos leave signatures on the expansion history of the Universe and on the growth of cosmic structure on small scales. With the rapid ongoing progress in observational cosmology, we can hope to measure the neutrino mass and significantly improve our understanding of dark energy over the next decade. In fact, the forecasted neutrino mass sensitivity of upcoming cosmological surveys is almost an order of magnitude tighter than from beta-decay particle experiments.

Modern cosmological surveys are probing progressively smaller scales of large-scale structure where cosmological information is moved beyond the power spectrum. A key challenge is theoretically modeling nonlinear gravity on these scales. N-body simulations provide such a model, however, are computationally expensive, especially when including neutrinos. In this <a href="https://doi.org/10.1088/1475-7516/2021/01/016">paper</a>, I contributed to the development of a fast N-body simulation, FastPM, by efficiently including the effects of neutrinos in the forward model. Fast simulations can be combined with more computationally expensive simulations to reduce statistical uncertainty; in this <a href="https://doi.org/10.1093/mnras/stac1501">paper</a>, I collaborated with the DESI simulations working group to reduce variance in the AbacusSummit simulations using the control variate method.
I have also used simulations to quantify the information content of large-scale structure; in this <a href="https://doi.org/10.3847/1538-4357/ac0e91">paper</a>, I showed that combining the matter power spectrum with halo and void abundances can provide strong constraints on neutrino mass -- a factor of 43 times better than using the power spectrum alone!

However, I also showed in this <a href="https://doi.org/10.1103/PhysRevD.105.123510">paper</a> that galaxy clustering or weak lensing alone are incapable of unlocking any nonlinear information about neutrino mass. It will thus me curcial to combine data from multiple cosmological probes, e.g. large-scale structure, galaxy peculiar velocities, and the cosmic microwave background (CMB).
Cross correlating different probes can break degeneracies between cosmological parameters, mitigate systematics, and, in turn, detect otherwise undetectable signals.
To facilitate such studies, I am working on field-level inference, combining with peculiar velocity informaiton, and am co-developing a large suite of simulations to study cross-correlations between CMB and galaxy observables.

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.html path="assets/img/Fisher_500_15000_Pkm_0.50_HMF_3.0e+01_7.0e+03_15_VSF_1.0e+01_3.0e+01_0.7_15_z=0Mnu_vs_s8-1.png" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>
<div class="caption">
   "Combining the matter power spectrum with halo and void abundances can provide strong constraints on neutrino mass -- a factor of 43 times better than using the power spectrum alone!"
</div>

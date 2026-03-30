---
layout: single
title: "Machine Learning for Cosmology"
description: "Using generative models and neural networks to accelerate and enhance cosmological analysis"
header:
  teaser: /assets/img/Fisher_500_15000_Pkm_0.50_HMF_3.0e+01_7.0e+03_15_VSF_1.0e+01_3.0e+01_0.7_15_z=0Mnu_vs_s8-1.png
importance: 4
excerpt: ""
---

Cosmological simulations are essential for interpreting observations of the Universe, but they are computationally expensive. Running a single high-resolution N-body simulation can require millions of CPU hours, and the demands of modern survey analyses --- which require thousands of simulations to estimate covariance matrices, train inference pipelines, or explore parameter spaces --- are rapidly outpacing available computational resources. Machine learning offers a path to dramatically accelerate parts of this pipeline.

### CHARM: Creating Halos with Auto-Regressive Models

One major bottleneck is populating dark matter simulations with realistic galaxies. The connection between dark matter halos and the galaxies they host is complex and stochastic. CHARM is a generative machine learning model that learns this mapping directly from high-fidelity simulations. Using auto-regressive networks, CHARM can rapidly generate realistic halo catalogs conditioned on the underlying dark matter field, capturing the full statistical properties of the halo--matter connection including assembly bias and environmental effects. This enables the fast production of mock galaxy catalogs for survey analysis at a fraction of the computational cost of traditional methods.

### Neural Networks for Neutrino Mass

Standard cosmological analyses compress the rich information in galaxy surveys and weak lensing maps into summary statistics like the power spectrum. However, in the nonlinear regime, significant information is encoded in the higher-order structure of the fields. I have developed convolutional neural network (CNN) architectures that operate directly on weak lensing convergence maps to constrain the neutrino mass. By learning to extract non-Gaussian features that are invisible to two-point statistics, these networks can substantially tighten neutrino mass constraints beyond what is achievable with traditional methods.

These machine learning approaches are not just faster alternatives to existing methods --- they enable entirely new analyses that would be impractical with conventional techniques.

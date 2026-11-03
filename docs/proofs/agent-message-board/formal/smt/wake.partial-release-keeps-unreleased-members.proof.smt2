; benchmark generated from python API
(set-info :status unknown)
(declare-fun p_ret (Int) Bool)
(declare-fun p_mem (Int Int) Bool)
(assert
 (let (($x559 (forall ((p_b Int) (p_m Int) )(let (($x619 (and (p_mem p_b p_m) (not (p_ret p_m)))))
(=> $x619 $x619)))
))
(not $x559)))
(check-sat)

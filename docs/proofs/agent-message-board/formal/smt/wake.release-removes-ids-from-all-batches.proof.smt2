; benchmark generated from python API
(set-info :status unknown)
(declare-fun e_mem (Int Int) Bool)
(declare-fun e_ret (Int) Bool)
(assert
 (forall ((dj_b1 Int) (dj_b2 Int) (dj_m Int) )(let (($x160 (e_mem dj_b2 dj_m)))
 (let (($x356 (not $x160)))
 (let (($x357 (e_mem dj_b1 dj_m)))
 (let (($x557 (and (distinct dj_b1 dj_b2) true)))
 (let (($x444 (and $x557 $x357)))
 (=> $x444 $x356)))))))
 )
(assert
 (let (($x845 (forall ((e_b Int) (e_m Int) )(let (($x251 (not (and (e_mem e_b e_m) (not (e_ret e_m))))))
(let (($x552 (e_ret e_m)))
(=> $x552 $x251))))
))
(not $x845)))
(check-sat)

; benchmark generated from python API
(set-info :status unknown)
(declare-fun m_mem (Int Int) Bool)
(declare-fun m_op () Int)
(declare-fun m_ins (Int) Bool)
(assert
 (forall ((dj_b1 Int) (dj_b2 Int) (dj_m Int) )(let (($x841 (m_mem dj_b2 dj_m)))
 (let (($x138 (not $x841)))
 (let (($x564 (m_mem dj_b1 dj_m)))
 (let (($x557 (and (distinct dj_b1 dj_b2) true)))
 (let (($x90 (and $x557 $x564)))
 (=> $x90 $x138)))))))
 )
(assert
 (>= m_op 0))
(assert
 (<= m_op 2))
(assert
 (forall ((m_b Int) (m_m Int) )(let (($x841 (m_mem m_b m_m)))
(let (($x138 (not $x841)))
(let (($x771 (m_ins m_m)))
(=> $x771 $x138)))))
)
(check-sat)
